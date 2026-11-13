import { $, $$, api, bytes, html, ic, mediaUrl, raw, setHTML, toast, uploadFile, type Field, type MediaRow, type SafeHTML } from './lib.js';

/**
 * Schema-driven form. State lives in a plain object; inputs carry a data-path
 * ("title", "tracks.2.audio") and write straight into it. Structural changes
 * (add/remove/move rows, media picks) re-render from state.
 */
export class SchemaForm {
  fields: Field[];
  state: Record<string, unknown>;
  root: HTMLElement;
  dirty = false;
  mediaCache = new Map<string, MediaRow>();
  private uploading = 0;

  constructor(root: HTMLElement, fields: Field[], initial: Record<string, unknown>) {
    this.root = root;
    this.fields = fields;
    this.state = structuredClone(initial);
    for (const f of fields) if (this.state[f.key] === undefined && f.default !== undefined) this.state[f.key] = f.default;
    root.addEventListener('input', (e) => this.onInput(e));
    root.addEventListener('change', (e) => this.onInput(e));
    root.addEventListener('click', (e) => this.onClick(e));
    root.addEventListener('dragover', (e) => { const z = (e.target as HTMLElement).closest('.mfield'); if (z) { e.preventDefault(); z.classList.add('drag'); } });
    root.addEventListener('dragleave', (e) => (e.target as HTMLElement).closest('.mfield')?.classList.remove('drag'));
    root.addEventListener('drop', (e) => {
      const z = (e.target as HTMLElement).closest<HTMLElement>('.mfield');
      if (!z || !e.dataTransfer?.files[0]) return;
      e.preventDefault(); z.classList.remove('drag');
      this.upload(z.dataset.path!, z.dataset.kind!, e.dataTransfer.files[0]);
    });
  }

  get busy(): boolean { return this.uploading > 0; }

  render(): void {
    setHTML(this.root, html`${this.fields.filter((f) => !f.hidden).map((f) => this.field(f, f.key, this.state[f.key]))}`);
  }

  private field(f: Field, path: string, v: unknown): SafeHTML {
    const id = 'f_' + path.replace(/\./g, '_');
    const req = f.required ? html`<span class="req" aria-hidden="true">*</span>` : '';
    const help = f.help ? html`<small class="help">${f.help}</small>` : '';
    const err = html`<small class="err" data-err="${path}" hidden></small>`;
    const label = html`<label class="lbl" for="${id}">${f.label}${req}</label>`;
    const common = raw(`id="${id}" data-path="${path}" ${f.required ? 'aria-required="true"' : ''}`);
    switch (f.type) {
      case 'text': case 'position':
        return html`<div class="fld">${label}<input class="inp" type="text" ${common} value="${v ?? ''}" ${f.max ? raw(`maxlength="${f.max}"`) : ''} ${f.type === 'position' ? raw('list="pos-presets"') : ''}>${help}${err}</div>`;
      case 'longtext':
        return html`<div class="fld">${label}<textarea class="inp" rows="3" ${common} ${f.max ? raw(`maxlength="${f.max}"`) : ''}>${v ?? ''}</textarea>${help}${err}</div>`;
      case 'paragraphs': {
        const text = Array.isArray(v) ? (v as string[]).join('\n\n') : String(v ?? '');
        return html`<div class="fld">${label}<textarea class="inp tall" rows="10" ${common} data-paragraphs>${text}</textarea>${help}<small class="help" data-wc="${path}">${wordCount(text)} words</small>${err}</div>`;
      }
      case 'number':
        return html`<div class="fld sm">${label}<input class="inp" type="number" inputmode="numeric" ${common} value="${v ?? ''}" ${f.min !== undefined ? raw(`min="${f.min}"`) : ''} ${f.max !== undefined ? raw(`max="${f.max}"`) : ''}>${help}${err}</div>`;
      case 'date':
        return html`<div class="fld sm">${label}<input class="inp" type="date" ${common} value="${v ?? ''}">${help}${err}</div>`;
      case 'time':
        return html`<div class="fld sm">${label}<input class="inp" type="time" ${common} value="${v ?? ''}">${help}${err}</div>`;
      case 'select': {
        const opts = [...new Set([...(f.options || []), ...(v ? [String(v)] : [])])];
        if (f.allowCustom) {
          return html`<div class="fld sm">${label}<input class="inp" type="text" list="dl_${id}" ${common} value="${v ?? ''}" placeholder="Choose or type"><datalist id="dl_${id}">${opts.map((o) => html`<option value="${o}">`)}</datalist>${help}${err}</div>`;
        }
        return html`<div class="fld sm">${label}<select class="inp" ${common}><option value="">${f.optionsFrom ? 'None' : 'Choose…'}</option>${opts.map((o) => html`<option value="${o}" ${o === v ? 'selected' : ''}>${f.optionLabels?.[o] ?? o}</option>`)}</select>${help}${err}</div>`;
      }
      case 'bool':
        return html`<div class="fld"><label class="toggle"><input type="checkbox" ${common} ${v ? 'checked' : ''}><span class="sw"></span><b>${f.label}</b></label>${help}${err}</div>`;
      case 'image': case 'video': case 'audio': case 'file':
        return html`<div class="fld"><span class="lbl">${f.label}${req}</span>${this.mediaField(path, f.type, v as string | null)}${help}${err}</div>`;
      case 'list': {
        const rows = (Array.isArray(v) ? v : []) as Record<string, unknown>[];
        return html`<div class="fld"><span class="lbl">${f.label} <span class="count">${rows.length}</span></span>
          <div class="list">${rows.map((row, i) => html`<fieldset class="lrow"><legend>${f.listLabel || 'Row'} ${i + 1}</legend>
            <div class="lrow-tools"><button type="button" class="ib" data-move="${path}.${i}" data-dir="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move up">${ic('up')}</button><button type="button" class="ib" data-move="${path}.${i}" data-dir="1" ${i === rows.length - 1 ? 'disabled' : ''} aria-label="Move down">${ic('down')}</button><button type="button" class="ib danger" data-remove="${path}.${i}" aria-label="Remove ${f.listLabel || 'row'} ${i + 1}">${ic('trash')}</button></div>
            <div class="grid">${(f.fields || []).map((sf) => this.field(sf, `${path}.${i}.${sf.key}`, row[sf.key]))}</div></fieldset>`)}</div>
          <button type="button" class="btn" data-add="${path}">${ic('plus')}Add ${(f.listLabel || 'row').toLowerCase()}</button>${err}</div>`;
      }
      default:
        return html``;
    }
  }

  private mediaField(path: string, kind: string, id: string | null): SafeHTML {
    const m = id ? this.mediaCache.get(id) : undefined;
    const preview = !id ? html`<div class="mempty">${ic(kind === 'image' ? 'image' : kind === 'video' ? 'tv' : kind === 'audio' ? 'music' : 'file', 'lg')}<span>Drop a file here or use the buttons</span></div>`
      : kind === 'image' ? html`<img src="${mediaUrl(id)}" alt="">`
      : kind === 'video' ? html`<video src="${mediaUrl(id)}" controls preload="metadata"></video>`
      : kind === 'audio' ? html`<audio src="${mediaUrl(id)}" controls preload="none"></audio>`
      : html`<a class="mfile" href="${mediaUrl(id)}" target="_blank" rel="noopener">${ic('file')}${m?.original_name || id}</a>`;
    const accept = kind === 'image' ? 'image/jpeg,image/png,image/webp,image/gif' : kind === 'video' ? 'video/mp4,video/quicktime,video/webm' : kind === 'audio' ? 'audio/*' : 'application/pdf';
    return html`<div class="mfield ${id ? 'has' : ''}" data-path="${path}" data-kind="${kind}">
      <div class="mprev">${preview}</div>
      <div class="mbar"><div class="prog" hidden><i></i><span></span></div>
        <label class="btn sm">${ic('upload')}${id ? 'Replace' : 'Upload'}<input type="file" accept="${accept}" data-upload="${path}" data-kind="${kind}" hidden></label>
        <button type="button" class="btn sm" data-pick="${path}" data-kind="${kind}">${ic('folder')}Library</button>
        ${id ? html`<button type="button" class="btn sm ghost" data-clear="${path}">${ic('close')}Remove</button>` : ''}
        ${m ? html`<span class="meta">${m.original_name} · ${bytes(m.size)}</span>` : ''}</div></div>`;
  }

  private onInput(e: Event) {
    const t = e.target as HTMLInputElement;
    if (t.dataset.upload && e.type === 'change' && t.files?.[0]) { this.upload(t.dataset.upload, t.dataset.kind!, t.files[0]); t.value = ''; return; }
    const path = t.dataset.path;
    if (!path) return;
    let v: unknown = t.type === 'checkbox' ? t.checked : t.value;
    if (t.type === 'number') v = t.value === '' ? null : Number(t.value);
    if (t.hasAttribute('data-paragraphs')) {
      const wc = $(`[data-wc="${path}"]`, this.root); if (wc) wc.textContent = `${wordCount(t.value)} words`;
    }
    setPath(this.state, path, v);
    this.dirty = true;
    const err = $(`[data-err="${path}"]`, this.root); if (err) err.hidden = true;
    t.classList.remove('bad');
  }

  private onClick(e: Event) {
    const t = (e.target as HTMLElement).closest<HTMLElement>('button');
    if (!t) return;
    const d = t.dataset;
    if (d.add) { const f = this.fieldAt(d.add); const list = (getPath(this.state, d.add) as unknown[]) || []; const row: Record<string, unknown> = {}; for (const sf of f?.fields || []) if (sf.default !== undefined) row[sf.key] = sf.default; list.push(row); setPath(this.state, d.add, list); this.dirty = true; this.render(); return; }
    if (d.remove) { const [listPath, idx] = splitLast(d.remove); const list = getPath(this.state, listPath) as unknown[]; list.splice(Number(idx), 1); this.dirty = true; this.render(); return; }
    if (d.move) { const [listPath, idx] = splitLast(d.move); const list = getPath(this.state, listPath) as unknown[]; const i = Number(idx), j = i + Number(d.dir); if (j < 0 || j >= list.length) return; [list[i], list[j]] = [list[j], list[i]]; this.dirty = true; this.render(); return; }
    if (d.clear) { setPath(this.state, d.clear, null); this.dirty = true; this.render(); return; }
    if (d.pick) { pickMedia(d.kind!, (m) => { this.mediaCache.set(m.id, m); setPath(this.state, d.pick!, m.id); this.dirty = true; this.afterMedia(d.pick!, m); this.render(); }); }
  }

  private async upload(path: string, kind: string, file: File) {
    const box = $(`.mfield[data-path="${CSS.escape(path)}"]`, this.root);
    const prog = box && $('.prog', box);
    const bar = prog && $('i', prog);
    const label = prog && $('span', prog);
    if (prog) prog.hidden = false;
    this.uploading++;
    try {
      const m = await uploadFile(file, (p) => { if (bar) bar.style.width = Math.round(p * 100) + '%'; if (label) label.textContent = `${Math.round(p * 100)}%`; });
      if (m.kind !== kind) { toast(`That's ${m.kind === 'image' ? 'an image' : `a ${m.kind}`} file — this field needs ${kind === 'image' ? 'an image' : `a ${kind}`}.`, 'err'); return; }
      this.mediaCache.set(m.id, m);
      setPath(this.state, path, m.id);
      this.dirty = true;
      await this.afterMedia(path, m, file);
      this.render();
      toast('Uploaded');
    } catch (e) {
      toast((e as Error).message, 'err');
      if (prog) prog.hidden = true;
    } finally { this.uploading--; }
  }

  /** Audio uploads fill the track's duration automatically. */
  private async afterMedia(path: string, m: MediaRow, file?: File) {
    if (m.kind !== 'audio' || !path.endsWith('.audio')) return;
    const durPath = path.replace(/\.audio$/, '.duration');
    const secs = await audioDuration(file ? URL.createObjectURL(file) : mediaUrl(m.id));
    if (secs) setPath(this.state, durPath, Math.round(secs));
  }

  private fieldAt(path: string): Field | undefined {
    const parts = path.split('.');
    let fields = this.fields, f: Field | undefined;
    for (const p of parts) { if (/^\d+$/.test(p)) continue; f = fields.find((x) => x.key === p); fields = f?.fields || []; }
    return f;
  }

  /** Show server-side validation errors next to their fields. Returns the first field element. */
  showErrors(errors: Record<string, string>): HTMLElement | null {
    let first: HTMLElement | null = null;
    for (const [path, msg] of Object.entries(errors)) {
      const el = $(`[data-err="${CSS.escape(path)}"]`, this.root) || $(`[data-err="${CSS.escape(path.split('.')[0])}"]`, this.root);
      if (el) { el.hidden = false; el.textContent = msg; first ||= el; }
      $(`[data-path="${CSS.escape(path)}"]`, this.root)?.classList.add('bad');
    }
    return first;
  }

  /** Client-side required check before sending. */
  missingRequired(): Record<string, string> {
    const out: Record<string, string> = {};
    const walk = (fields: Field[], obj: Record<string, unknown>, prefix: string) => {
      for (const f of fields) {
        const v = obj?.[f.key];
        const p = prefix + f.key;
        if (f.required && (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length))) out[p] = `${f.label} is required`;
        if (f.type === 'list' && Array.isArray(v)) v.forEach((row, i) => walk(f.fields || [], row as Record<string, unknown>, `${p}.${i}.`));
      }
    };
    walk(this.fields, this.state, '');
    return out;
  }

  async loadMediaMeta(): Promise<void> {
    try {
      const r = await api<{ media: MediaRow[] }>('/api/admin/media');
      for (const m of r.media) this.mediaCache.set(m.id, m);
    } catch { /* previews still work without metadata */ }
  }
}

const wordCount = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);
function splitLast(p: string): [string, string] { const i = p.lastIndexOf('.'); return [p.slice(0, i), p.slice(i + 1)]; }
export function getPath(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]), obj);
}
export function setPath(obj: Record<string, unknown>, path: string, v: unknown): void {
  const parts = path.split('.');
  let o: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (o[parts[i]] == null) o[parts[i]] = /^\d+$/.test(parts[i + 1]) ? [] : {};
    o = o[parts[i]] as Record<string, unknown>;
  }
  o[parts[parts.length - 1]] = v;
}
function audioDuration(src: string): Promise<number | null> {
  return new Promise((resolve) => {
    const a = new Audio();
    const done = (v: number | null) => { a.src = ''; resolve(v); };
    a.preload = 'metadata';
    a.onloadedmetadata = () => done(Number.isFinite(a.duration) ? a.duration : null);
    a.onerror = () => done(null);
    setTimeout(() => done(null), 8000);
    a.src = src;
  });
}

/* ---------- media library picker (modal) ---------- */
export async function pickMedia(kind: string, onPick: (m: MediaRow) => void): Promise<void> {
  const d = document.createElement('dialog');
  d.className = 'dlg wide';
  setHTML(d, html`<div class="dlg-h"><h3>Choose from library</h3><button class="ib" data-x aria-label="Close">${ic('close')}</button></div><div class="mgrid" data-grid><div class="muted">Loading…</div></div>`);
  document.body.appendChild(d);
  d.showModal();
  d.addEventListener('close', () => d.remove());
  d.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-x],[data-id]');
    if (e.target === d || t?.hasAttribute('data-x')) { d.close(); return; }
    if (t?.dataset.id) { const m = list.find((x) => x.id === t.dataset.id); if (m) { onPick(m); d.close(); } }
  });
  let list: MediaRow[] = [];
  try {
    list = (await api<{ media: MediaRow[] }>(`/api/admin/media?kind=${kind}`)).media;
  } catch (e) { setHTML($('[data-grid]', d)!, html`<div class="muted">${(e as Error).message}</div>`); return; }
  setHTML($('[data-grid]', d)!, list.length ? html`${list.map((m) => html`<button class="mcard" data-id="${m.id}" title="${m.original_name}">${thumb(m)}<span>${m.original_name}</span></button>`)}` : html`<div class="muted">No ${kind} files uploaded yet. Use Upload instead.</div>`);
}
export function thumb(m: MediaRow): SafeHTML {
  if (m.kind === 'image') return html`<img src="${mediaUrl(m.id)}" alt="" loading="lazy">`;
  if (m.kind === 'video') return html`<video src="${mediaUrl(m.id)}#t=0.5" preload="metadata" muted></video>`;
  return html`<div class="ficon">${ic(m.kind === 'audio' ? 'music' : 'file', 'lg')}</div>`;
}
export { $$ };
