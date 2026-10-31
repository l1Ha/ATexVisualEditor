/**
 * ATexVisualEditor — HTTP client for the local server.
 *
 * Every call goes through here so error handling is uniform and the UI never
 * has to think about URLs.
 */

export class ApiError extends Error {
  constructor(message, status, detail) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

export class Api {
  constructor() {
    this.status = null;
    this.projectId = null;
  }

  async request(path, { method = 'GET', body = null, raw = false, signal = null } = {}) {
    const init = { method, signal };
    if (body !== null) {
      if (body instanceof ArrayBuffer || body instanceof Blob) {
        init.body = body;
      } else {
        init.headers = { 'Content-Type': 'application/json' };
        init.body = JSON.stringify(body);
      }
    }
    let response;
    try {
      response = await fetch(path, init);
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      throw new ApiError('Cannot reach the editor server. Is it still running?', 0, String(err));
    }
    if (raw) {
      if (!response.ok) throw new ApiError(`Request failed (${response.status})`, response.status);
      return response;
    }
    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
    }
    if (!response.ok) {
      const message = data && data.error ? data.error : `Request failed (${response.status})`;
      throw new ApiError(message, response.status, data && data.detail);
    }
    return data;
  }

  get(path, options) {
    return this.request(path, options);
  }

  post(path, body, options) {
    return this.request(path, { ...options, method: 'POST', body });
  }

  put(path, body, options) {
    return this.request(path, { ...options, method: 'PUT', body });
  }

  del(path, options) {
    return this.request(path, { ...options, method: 'DELETE' });
  }

  // -- endpoints -----------------------------------------------------------

  serverStatus() {
    return this.get('/api/status');
  }

  listProjects() {
    return this.get('/api/projects');
  }

  createProject(name, template) {
    return this.post('/api/projects', { name, template });
  }

  deleteProject(id) {
    return this.del(`/api/projects/${encodeURIComponent(id)}`);
  }

  duplicateProject(id) {
    return this.post(`/api/projects/${encodeURIComponent(id)}/duplicate`, {});
  }

  openProject(id) {
    this.projectId = id;
    return this.get(`/api/projects/${encodeURIComponent(id)}`);
  }

  projectTree(id = this.projectId) {
    return this.get(`/api/projects/${encodeURIComponent(id)}/tree`);
  }

  readFile(path, id = this.projectId) {
    return this.get(`/api/projects/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}`);
  }

  writeFile(path, content, id = this.projectId) {
    return this.put(`/api/projects/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}`, { content });
  }

  deleteFile(path, id = this.projectId) {
    return this.del(`/api/projects/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}`);
  }

  mkdir(path, id = this.projectId) {
    return this.post(`/api/projects/${encodeURIComponent(id)}/mkdir`, { path });
  }

  rename(from, to, id = this.projectId) {
    return this.post(`/api/projects/${encodeURIComponent(id)}/rename`, { from, to });
  }

  saveSettings(id = this.projectId, settings) {
    return this.put(`/api/projects/${encodeURIComponent(id)}`, settings);
  }

  compile({ main, engine, synctex = true, includeLog = true, timeout = null } = {}) {
    return this.post(`/api/projects/${encodeURIComponent(this.projectId)}/compile`, {
      main,
      engine,
      synctex,
      includeLog,
      timeout,
    });
  }

  syncTex(body) {
    return this.post(`/api/projects/${encodeURIComponent(this.projectId)}/synctex`, body);
  }

  // -- URLs ----------------------------------------------------------------

  pageUrl(page, kind = 'svg', build = null, dpi = null) {
    const params = new URLSearchParams();
    if (build) params.set('build', build);
    if (dpi) params.set('dpi', String(dpi));
    const query = params.toString();
    return `/api/projects/${encodeURIComponent(this.projectId)}/page/${page}.${kind}${query ? `?${query}` : ''}`;
  }

  pdfUrl(build = null, { download = false } = {}) {
    const params = new URLSearchParams();
    if (build) params.set('build', build);
    if (download) params.set('download', '1');
    const query = params.toString();
    return `/api/projects/${encodeURIComponent(this.projectId)}/pdf${query ? `?${query}` : ''}`;
  }

  rawUrl(path) {
    return `/api/projects/${encodeURIComponent(this.projectId)}/raw?path=${encodeURIComponent(path)}`;
  }

  exportUrl() {
    return `/api/projects/${encodeURIComponent(this.projectId)}/export`;
  }
}
