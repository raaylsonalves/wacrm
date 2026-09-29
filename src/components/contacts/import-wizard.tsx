'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { CSV_MAX_BYTES, decodeCsv, parseCsv } from '@/lib/csv/parse';
import {
  CONSENT_BASES,
  UPDATE_POLICIES,
  planImport,
  type ConsentBasis,
  type ImportPlan,
  type UpdatePolicy,
} from '@/lib/contacts/import-plan';

interface ImportResult {
  name: string;
  list_tag: string;
  consent_basis: ConsentBasis;
  rows_total: number;
  created: number;
  updated: number;
  skipped: number;
  ignored_columns: string[];
  errors: { line: number; reason: string; raw: string }[];
}

/**
 * CSV import (specs/prospecting-csv-import.md, part A). The file is
 * previewed here with the same parser the server uses, then imported on
 * the server, which answers with a per-line report.
 */
export function ImportWizard({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => void;
}) {
  const t = useTranslations('Contacts.importWizard');
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPlan | null>(null);
  const [name, setName] = useState('');
  const [basis, setBasis] = useState<ConsentBasis | ''>('');
  const [legalRef, setLegalRef] = useState('');
  const [policy, setPolicy] = useState<UpdatePolicy>('fill_empty');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  function reset() {
    setFile(null);
    setPreview(null);
    setName('');
    setBasis('');
    setLegalRef('');
    setPolicy('fill_empty');
    setResult(null);
    if (fileRef.current) fileRef.current.value = '';
  }

  async function pick(f: File | undefined) {
    if (!f) return;
    if (f.size > CSV_MAX_BYTES) {
      toast.error(t('errors.file_too_large'));
      return;
    }
    const plan = planImport(parseCsv(decodeCsv(new Uint8Array(await f.arrayBuffer()))));
    if (!plan.columns.includes('phone')) {
      toast.error(t('errors.phone_column_missing'));
      return;
    }
    setFile(f);
    setPreview(plan);
    setName(f.name.replace(/\.csv$/i, ''));
  }

  const legalOk = basis !== 'legitimate_interest' || legalRef.trim().length >= 10;
  const canSubmit = !!file && !!basis && legalOk && !busy;

  async function submit() {
    if (!file || !basis) return;
    setBusy(true);
    try {
      const body = new FormData();
      body.append('file', file);
      body.append('name', name.trim());
      body.append('consent_basis', basis);
      body.append('legal_basis_ref', legalRef.trim());
      body.append('update_policy', policy);
      const res = await fetch('/api/contacts/imports', { method: 'POST', body });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const code = String(data?.error ?? '');
        toast.error(t.has(`errors.${code}`) ? t(`errors.${code}`) : t('errors.generic'));
        return;
      }
      setResult(data as ImportResult);
      onImported();
    } catch {
      toast.error(t('errors.generic'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        {result ? (
          <ResultView result={result} t={t} />
        ) : (
          <div className="space-y-5">
            <div className="space-y-2">
              <input
                ref={fileRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(e) => void pick(e.target.files?.[0])}
              />
              <Button type="button" variant="outline" onClick={() => fileRef.current?.click()}>
                <Upload className="size-4" />
                {file ? file.name : t('pickFile')}
              </Button>
              <p className="text-muted-foreground text-xs">{t('fileHint')}</p>
              {preview && (
                <p className="text-xs">
                  {t('preview', {
                    rows: preview.rows.length,
                    skipped: preview.skipped.length,
                    columns: preview.columns.join(', '),
                  })}
                  {preview.ignoredColumns.length > 0 &&
                    ` ${t('ignored', { columns: preview.ignoredColumns.join(', ') })}`}
                </p>
              )}
            </div>

            {preview && (
              <>
                <div className="space-y-1.5">
                  <Label>{t('listName')}</Label>
                  <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
                  <p className="text-muted-foreground text-xs">{t('listNameHint')}</p>
                </div>

                <div className="space-y-2">
                  <Label>{t('basis.question')}</Label>
                  <RadioGroup value={basis} onValueChange={(v) => setBasis(v as ConsentBasis)}>
                    {CONSENT_BASES.map((b) => (
                      <label key={b} className="flex items-start gap-2 text-sm">
                        <RadioGroupItem value={b} className="mt-0.5" />
                        <span>
                          <span className="font-medium">{t(`basis.${b}.label`)}</span>
                          <span className="text-muted-foreground block text-xs">
                            {t(`basis.${b}.effect`)}
                          </span>
                        </span>
                      </label>
                    ))}
                  </RadioGroup>
                  {basis === 'legitimate_interest' && (
                    <Textarea
                      value={legalRef}
                      onChange={(e) => setLegalRef(e.target.value)}
                      placeholder={t('basis.legalRefPlaceholder')}
                      rows={3}
                    />
                  )}
                  <p className="text-muted-foreground text-xs">{t('basis.disclaimer')}</p>
                </div>

                <div className="space-y-1.5">
                  <Label>{t('policy.label')}</Label>
                  <Select value={policy} onValueChange={(v) => setPolicy(v as UpdatePolicy)}>
                    <SelectTrigger>
                      <SelectValue>{(v: string) => t(`policy.${v}`)}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {UPDATE_POLICIES.map((p) => (
                        <SelectItem key={p} value={p}>
                          {t(`policy.${p}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </>
            )}
          </div>
        )}

        <DialogFooter>
          {result ? (
            <Button onClick={() => onOpenChange(false)}>{t('close')}</Button>
          ) : (
            <Button onClick={() => void submit()} disabled={!canSubmit}>
              {busy && <Loader2 className="size-4 animate-spin" />}
              {t('import')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ResultView({
  result,
  t,
}: {
  result: ImportResult;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <div className="space-y-3 text-sm">
      <p>
        {t('result.summary', {
          created: result.created,
          updated: result.updated,
          skipped: result.skipped,
        })}
      </p>
      <p className="text-muted-foreground text-xs">{t('result.tag', { tag: result.list_tag })}</p>
      {result.consent_basis === 'third_party_list' && (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-xs">
          {t('result.thirdParty')}
        </p>
      )}
      {result.errors.length > 0 && (
        <div className="max-h-56 overflow-y-auto rounded-md border">
          <table className="w-full text-xs">
            <thead className="bg-muted/50">
              <tr>
                <th className="px-2 py-1 text-left">{t('result.line')}</th>
                <th className="px-2 py-1 text-left">{t('result.reason')}</th>
                <th className="px-2 py-1 text-left">{t('result.content')}</th>
              </tr>
            </thead>
            <tbody>
              {result.errors.map((e) => (
                <tr key={e.line} className="border-t">
                  <td className="px-2 py-1">{e.line}</td>
                  <td className="px-2 py-1">
                    {t.has(`reasons.${e.reason}`) ? t(`reasons.${e.reason}`) : e.reason}
                  </td>
                  <td className="text-muted-foreground truncate px-2 py-1">{e.raw}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
