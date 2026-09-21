import { describe, it, expect } from 'vitest';
import {
  buildAnonymizedContactFields,
  parseStorageObjectUrl,
} from './anonymize';

describe('buildAnonymizedContactFields', () => {
  it('clears every PII field and stamps anonymized_at', () => {
    const now = new Date('2026-09-21T12:00:00.000Z');
    const fields = buildAnonymizedContactFields(
      '12345678-aaaa-bbbb-cccc-000000000000',
      now
    );

    expect(fields).toEqual({
      name: 'Cliente Anonimizado #12345678',
      phone: '',
      email: null,
      company: null,
      avatar_url: null,
      wa_user_id: null,
      wa_parent_user_id: null,
      wa_username: null,
      anonymized_at: '2026-09-21T12:00:00.000Z',
    });
  });

  it('derives a distinct name per contact id', () => {
    const a = buildAnonymizedContactFields(
      'aaaaaaaa-0000-0000-0000-000000000000'
    );
    const b = buildAnonymizedContactFields(
      'bbbbbbbb-0000-0000-0000-000000000000'
    );
    expect(a.name).not.toBe(b.name);
  });
});

describe('parseStorageObjectUrl', () => {
  it('extracts bucket and path from a public object URL', () => {
    expect(
      parseStorageObjectUrl(
        'https://xyz.supabase.co/storage/v1/object/public/chat-media/account-123/1690000000-photo.jpg'
      )
    ).toEqual({
      bucket: 'chat-media',
      path: 'account-123/1690000000-photo.jpg',
    });
  });

  it('decodes URL-encoded path segments', () => {
    expect(
      parseStorageObjectUrl(
        'https://xyz.supabase.co/storage/v1/object/public/chat-media/account-123/my%20file.pdf'
      )
    ).toEqual({
      bucket: 'chat-media',
      path: 'account-123/my file.pdf',
    });
  });

  it('returns null for a non-storage URL', () => {
    expect(parseStorageObjectUrl('https://example.com/image.jpg')).toBeNull();
    expect(parseStorageObjectUrl('')).toBeNull();
  });
});
