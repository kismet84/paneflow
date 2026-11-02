export function parseConnection(input) {
  const raw = input.trim();
  if (!raw || raw.length > 16000 || /[\u0000-\u0020\u007f]/.test(raw)) throw new Error('请输入完整的配对链接或中继地址。');
  let url;
  try { url = new URL(raw); } catch { throw new Error('链接格式不正确。'); }
  if (url.username || url.password || url.search) throw new Error('地址不能包含用户名、密码或查询参数。');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === 'localhost')) {
    throw new Error('仅支持 HTTPS；USB 测试可使用 http://localhost。');
  }
  if (!/^\/(?:[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*)?\/?$/.test(url.pathname)) throw new Error('中继路径格式不正确。');
  if (url.hash) {
    const pairs = [...new URLSearchParams(url.hash.slice(1))];
    if (pairs.length !== 1 || pairs[0][0] !== 'pair' || !/^[A-Za-z0-9_-]+$/.test(pairs[0][1])) throw new Error('配对信息格式不正确，请重新复制桌面链接。');
  }
  const openUrl = url.href;
  url.hash = '';
  return { openUrl, homeUrl: url.href, isPairing: openUrl !== url.href };
}
