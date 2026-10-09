/* 临时：只验证「登录页解析」这一段（不发 doLogin，不产生任何会话副作用）。
   目的是确认正则能匹配真实登录页 —— 这是唯一能在不顶掉浏览器会话的前提下验证的部分。 */
const PAGE_URL =
  'https://mozi-login.alibaba-inc.com/?APP_NAME=LOGISTICS_COMPANY&BACK_URL=' +
  encodeURIComponent('https://aeolus.ele.me?_tplCode=mknnjrtsvw9cj96u') +
  '&moziAppType=LOGISTICS_COMPANY';

const HEADERS = {
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-US;q=0.7',
  Origin: 'https://mozi-login.alibaba-inc.com',
  Referer: PAGE_URL,
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0',
};

(async () => {
  const res = await fetch(PAGE_URL, { headers: HEADERS, redirect: 'follow' });
  const html = await res.text();
  console.log('HTTP', res.status, 'html_len', html.length);
  const pub = /'rsaPublicKey'\s*:\s*'([0-9a-fA-F]+)'/.exec(html)?.[1];
  const csrf = /'_sso_csrftoken_'\s*:\s*'([0-9A-Za-z]+)'/.exec(html)?.[1];
  const umid = /'umidTokenId'\s*:\s*'([0-9A-Za-z]+)'/.exec(html)?.[1];
  console.log('rsaPublicKey :', pub ? `OK len=${pub.length} head=${pub.slice(0, 16)}` : 'MISS');
  console.log('_sso_csrftoken_:', csrf ? `OK len=${csrf.length}` : 'MISS(可为空)');
  console.log('umidTokenId  :', umid ? `OK len=${umid.length}` : 'MISS(可为空)');
  const setCookies = res.headers.getSetCookie?.() ?? [];
  console.log('set-cookie count:', setCookies.length, '| names:', setCookies.map((c) => c.split('=')[0]).join(','));
  process.exit(pub ? 0 : 1);
})().catch((e) => {
  console.error('FAIL', e.message);
  process.exit(2);
});
