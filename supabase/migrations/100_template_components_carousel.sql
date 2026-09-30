-- 100_template_components_carousel.sql
--
-- Carousel templates (specs: "suporte a formatos de template da Meta").
--
--   components     the template exactly as Meta returns it on sync. The
--                  flattened columns (header_*, body_text, buttons) stay for
--                  every existing reader; formats they can't describe —
--                  starting with CAROUSEL — are built from this.
--   carousel_media the media link for each carousel card, by card index.
--                  Like header_media_url for a media header: Meta needs the
--                  media on every send, so it is saved once on the template
--                  and reused by broadcasts (immediate and scheduled), the
--                  inbox and automations.

ALTER TABLE message_templates ADD COLUMN IF NOT EXISTS components jsonb;
ALTER TABLE message_templates ADD COLUMN IF NOT EXISTS carousel_media jsonb;

-- Carousels become sendable; the next sync recomputes the rest.
UPDATE message_templates SET unsupported_reason = NULL WHERE unsupported_reason = 'carousel';
