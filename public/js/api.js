// public/js/api.js
// ============================================================
// Shared fetch wrapper + auth/local-state helpers for the frontend.
// ============================================================

const ShadowAPI = (() => {
  const TOKEN_KEY = 'shadow_token';
  const USER_KEY = 'shadow_user';

  function getToken() {
    return localStorage.getItem(TOKEN_KEY);
  }
  function setToken(token) {
    localStorage.setItem(TOKEN_KEY, token);
  }
  function clearToken() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  }
  function getUser() {
    try {
      return JSON.parse(localStorage.getItem(USER_KEY) || 'null');
    } catch {
      return null;
    }
  }
  function setUser(user) {
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  }

  async function request(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    const token = getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await fetch(path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    let data = {};
    try { data = await res.json(); } catch { /* no body */ }

    if (!res.ok || data.success === false) {
      if (res.status === 401 && !path.includes('action=login')) {
        // Token invalid/expired — bounce to login.
        clearToken();
      }
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function get(path) { return request('GET', path); }
  function post(path, body) { return request('POST', path, body); }
  function put(path, body) { return request('PUT', path, body); }
  function patch(path, body) { return request('PATCH', path, body); }
  function del(path, body) { return request('DELETE', path, body); }

  return { getToken, setToken, clearToken, getUser, setUser, get, post, put, patch, delete: del };
})();
