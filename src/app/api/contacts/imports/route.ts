// ============================================================
// POST /api/contacts/imports  (agent+) — import a CSV of contacts
// (specs/prospecting-csv-import.md, part A).
//
// Multipart: file, name, consent_basis, legal_basis_ref?, update_policy.
// Parsed on the SERVER (the old importer ran in the browser tab, so
// closing it left half a file imported). Every row gets an outcome; a bad
// row is reported with its line and reason, never sinks the rest.
//
// Runs on the RLS client: every write is scoped by the caller's own
// membership, and the explicit account filters stay as a second guard.
// ============================================================

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { canEditSettings } from '@/lib/auth/roles'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { audit } from '@/lib/audit'
import { CSV_MAX_BYTES, CSV_MAX_ROWS, decodeCsv, parseCsv } from '@/lib/csv/parse'
import {
  CONSENT_BASES,
  UPDATE_POLICIES,
  mergeConsentBasis,
  planImport,
  updateFor,
  type ConsentBasis,
  type SkipReason,
  type UpdatePolicy,
} from '@/lib/contacts/import-plan'
import {
  assignImportedContactTags,
  resolveImportTagIds,
  type ContactTagAssignment,
} from '@/lib/contacts/resolve-import-tags'

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 })
}

interface ExistingRow {
  id: string
  phone_normalized: string
  name: string | null
  email: string | null
  company: string | null
  opted_out_at: string | null
  consent_basis: string | null
}

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId, role } = await requireRole('agent')

    const limit = checkRateLimit(`contact-import:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const form = await request.formData().catch(() => null)
    if (!form) return bad('Expected multipart form data')
    const file = form.get('file')
    if (!(file instanceof File)) return bad('file is required')
    if (file.size > CSV_MAX_BYTES) return bad('file_too_large')

    const name = String(form.get('name') ?? '').trim().slice(0, 120) || file.name
    const basis = String(form.get('consent_basis') ?? '') as ConsentBasis
    if (!(CONSENT_BASES as readonly string[]).includes(basis)) return bad('consent_basis is required')
    const legalRef = String(form.get('legal_basis_ref') ?? '').trim().slice(0, 1000)
    if (basis === 'legitimate_interest' && legalRef.length < 10) {
      return bad('legal_basis_ref is required for legitimate_interest')
    }
    const policy = (String(form.get('update_policy') ?? 'fill_empty') as UpdatePolicy)
    if (!(UPDATE_POLICIES as readonly string[]).includes(policy)) return bad('invalid update_policy')

    const table = parseCsv(decodeCsv(new Uint8Array(await file.arrayBuffer())))
    if (table.length < 2) return bad('empty_file')
    if (table.length - 1 > CSV_MAX_ROWS) return bad('too_many_rows')
    const plan = planImport(table)
    if (!plan.columns.includes('phone')) return bad('phone_column_missing')

    const { data: imp, error: impErr } = await supabase
      .from('contact_imports')
      .insert({
        account_id: accountId,
        name,
        file_name: file.name.slice(0, 200),
        consent_basis: basis,
        legal_basis_ref: legalRef || null,
        update_policy: policy,
        rows_total: table.length - 1,
        created_by: userId,
      })
      .select('id')
      .single()
    if (impErr || !imp) {
      console.error('[contacts/imports] could not create the import row:', impErr)
      return NextResponse.json({ error: 'Failed to start the import' }, { status: 500 })
    }
    const importId = imp.id as string

    const skipped: { line: number; reason: SkipReason; raw: string }[] = [...plan.skipped]
    let created = 0
    let updated = 0
    const assignments: ContactTagAssignment[] = []
    const listTag = `lista:${name}`.slice(0, 60)

    // Existing contacts, by exact normalized phone, in batches.
    const existing = new Map<string, ExistingRow>()
    const phones = plan.rows.map((r) => r.phone)
    for (let i = 0; i < phones.length; i += 200) {
      const { data } = await supabase
        .from('contacts')
        .select('id, phone_normalized, name, email, company, opted_out_at, consent_basis')
        .eq('account_id', accountId)
        .in('phone_normalized', phones.slice(i, i + 200))
      for (const c of (data ?? []) as ExistingRow[]) existing.set(c.phone_normalized, c)
    }

    const toInsert: typeof plan.rows = []
    for (const row of plan.rows) {
      const found = existing.get(row.phone)
      if (!found) {
        toInsert.push(row)
        continue
      }
      // Opted out stays opted out, and is never messaged because of a list.
      if (found.opted_out_at) {
        skipped.push({ line: row.line, reason: 'opted_out', raw: row.phone })
        continue
      }
      const fields = updateFor(policy, found, row)
      if (fields === null) {
        skipped.push({ line: row.line, reason: 'exists', raw: row.phone })
        continue
      }
      const nextBasis = mergeConsentBasis(found.consent_basis, basis)
      const { error } = await supabase
        .from('contacts')
        .update({ ...fields, consent_basis: nextBasis })
        .eq('id', found.id)
        .eq('account_id', accountId)
      if (error) {
        skipped.push({ line: row.line, reason: 'failed', raw: row.phone })
        continue
      }
      updated++
      assignments.push({ contactId: found.id, tagNames: [listTag, ...row.tags] })
    }

    for (let i = 0; i < toInsert.length; i += 200) {
      const chunk = toInsert.slice(i, i + 200)
      const payload = (r: (typeof chunk)[number]) => ({
        user_id: userId,
        account_id: accountId,
        phone: r.phone,
        name: r.name,
        email: r.email,
        company: r.company,
        import_id: importId,
        consent_basis: basis,
      })
      const { data, error } = await supabase.from('contacts').insert(chunk.map(payload)).select('id')
      if (!error && data && data.length === chunk.length) {
        data.forEach((c, j) => {
          created++
          assignments.push({ contactId: c.id as string, tagNames: [listTag, ...chunk[j].tags] })
        })
        continue
      }
      // One bad row must not sink the chunk: retry one by one.
      for (const r of chunk) {
        const { data: one, error: oneErr } = await supabase
          .from('contacts')
          .insert(payload(r))
          .select('id')
          .single()
        if (!oneErr && one) {
          created++
          assignments.push({ contactId: one.id as string, tagNames: [listTag, ...r.tags] })
        } else {
          const dup = (oneErr as { code?: string } | null)?.code === '23505'
          skipped.push({ line: r.line, reason: dup ? 'exists' : 'failed', raw: r.phone })
        }
      }
    }

    // The list tag is always created (it is how the list is found later);
    // other tag names from the file follow the usual "admins create tags" rule.
    const { tagIdByKey: listIds } = await resolveImportTagIds(supabase, {
      accountId,
      userId,
      tagNames: [listTag],
      canCreateTags: true,
    })
    const { tagIdByKey } = await resolveImportTagIds(supabase, {
      accountId,
      userId,
      tagNames: assignments.flatMap((a) => a.tagNames.slice(1)),
      canCreateTags: canEditSettings(role),
    })
    for (const [k, v] of listIds) tagIdByKey.set(k, v)
    if (assignments.length > 0) {
      await assignImportedContactTags(supabase, assignments, tagIdByKey)
    }

    skipped.sort((a, b) => a.line - b.line)
    for (let i = 0; i < skipped.length; i += 500) {
      const { error } = await supabase.from('contact_import_errors').insert(
        skipped.slice(i, i + 500).map((s) => ({
          import_id: importId,
          line: s.line,
          reason: s.reason,
          raw: s.raw,
        })),
      )
      if (error) console.warn('[contacts/imports] could not store the report:', error.message)
    }

    await supabase
      .from('contact_imports')
      .update({
        status: 'completed',
        rows_created: created,
        rows_updated: updated,
        rows_skipped: skipped.length,
      })
      .eq('id', importId)

    void audit({
      accountId,
      actorUserId: userId,
      action: 'contacts.imported',
      resourceType: 'contact_import',
      resourceId: importId,
      metadata: { name, basis, created, updated, skipped: skipped.length },
    })

    return NextResponse.json({
      id: importId,
      name,
      list_tag: listTag,
      consent_basis: basis,
      rows_total: table.length - 1,
      created,
      updated,
      skipped: skipped.length,
      columns: plan.columns,
      ignored_columns: plan.ignoredColumns,
      errors: skipped.slice(0, 200).map(({ line, reason, raw }) => ({ line, reason, raw })),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
