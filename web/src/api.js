let token = "";

export function setToken(value) {
  token = value;
}

export async function api(url, method = "GET", payload) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (method !== "GET") {
    headers["Idempotency-Key"] = crypto.randomUUID();
    headers["Content-Type"] = "application/json";
  }
  const response = await fetch(url, {
    method,
    headers,
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error?.code || `请求失败 ${response.status}`);
  return data;
}

export const base = (domain) => `/api/domains/${encodeURIComponent(domain)}`;

export async function downloadAttachment(url, filename) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error("附件不可读取或已过期");
  const blobUrl = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = blobUrl;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
}
