function compile(path) {
  const keys = [];
  const source = path
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        keys.push(seg.slice(1));
        return '([^/]+)';
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { keys, regex: new RegExp(`^${source}/?$`) };
}

export function createRouter() {
  const routes = [];
  const add = (method, path, handler) => {
    const { keys, regex } = compile(path);
    routes.push({ method, regex, keys, handler });
  };
  const handle = (method, url, ctx) => {
    const path = url.pathname.replace(/\/+$/, '') || '/';
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = path.match(r.regex);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => {
        params[k] = decodeURIComponent(m[i + 1]);
      });
      return r.handler(ctx, params);
    }
    return null;
  };
  return {
    get: (p, h) => add('GET', p, h),
    post: (p, h) => add('POST', p, h),
    put: (p, h) => add('PUT', p, h),
    patch: (p, h) => add('PATCH', p, h),
    delete: (p, h) => add('DELETE', p, h),
    handle,
  };
}