-- v0.5.0 — multi-format material exports.
--
-- Each application can now have a resume + cover delivered in any subset of
-- {pdf, tex, docx}. The PDF paths are still kept on resume_path / cover_path for the
-- tracker / apply_prefill fast-path (no JSON parse needed); the new
-- rendered_files column carries the full per-format map so the chat can hand
-- the user editable sources alongside the PDF.
--
-- Shape:
--   {
--     "resume": { "pdf":  "pdfs/resume-...-abc.pdf",
--                 "tex":  "tex/resume-...-abc.tex",
--                 "docx": "docx/resume-...-abc.docx" },
--     "cover":  { "pdf":  "pdfs/cover-...-abc.pdf",
--                 "tex":  "tex/cover-...-abc.tex",
--                 "docx": "docx/cover-...-abc.docx" }
--   }
-- Any missing format is simply absent. Re-rendering one format updates only that key.

ALTER TABLE applications ADD COLUMN rendered_files TEXT;
