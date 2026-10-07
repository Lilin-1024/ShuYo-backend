const ACADEMIC_IDENTITY_URL =
  'https://jwxt.shu.edu.cn/jwglxt/xsxy/xsxyqk_cxXsxyqkIndex.html?echarts=1&gnmkdm=N105515&layout=default';
const MAX_SCHOOL_RESPONSE_BYTES = 8 * 1024 * 1024;

function validCookieHeader(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 8192) return false;
  return value.split(';').every((part) =>
    /^\s*[!#$%&'*+.^_`|~0-9A-Za-z-]+=[^;\r\n]*\s*$/.test(part)
  );
}

function parseStudentId(html) {
  const form = /<form\b[^>]*\s+id\s*=\s*(?:"form"|'form'|form)(?=[\s>])[^>]*>/i.exec(html);
  if (!form) return null;
  const formStart = form.index + form[0].length;
  const formEnd = html.indexOf('</form>', formStart);
  const formBody = html.slice(formStart, formEnd < 0 ? undefined : formEnd);
  for (const tag of formBody.match(/<input\b[^>]*>/gi) ?? []) {
    if (!/\bname\s*=\s*(["'])xh_id\1/i.test(tag)) continue;
    const value = tag.match(/\bvalue\s*=\s*(["'])(.*?)\1/i)?.[2]?.trim();
    if (value && /^[A-Za-z0-9]{6,24}$/.test(value)) return value;
  }
  return null;
}

function maskedStudentId(studentId) {
  if (studentId.length <= 4) return '****';
  return `${studentId.slice(0, 2)}${'*'.repeat(studentId.length - 4)}${studentId.slice(-2)}`;
}

async function readStudentId(response) {
  const reader = response.body?.getReader();
  if (!reader) return { status: 'no_student_id' };
  const decoder = new TextDecoder('utf-8');
  let html = '';
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    html += decoder.decode(value, { stream: true });
    const studentId = parseStudentId(html);
    if (studentId) {
      await reader.cancel().catch(() => {});
      return { status: 'verified', studentId };
    }
    if (total > MAX_SCHOOL_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      return { status: 'school_response_too_large' };
    }
  }
  return { status: 'no_student_id' };
}

async function probeSchoolIdentity({ cookieHeader, expectedStudentId, fetchImpl = fetch }) {
  if (!validCookieHeader(cookieHeader)) return { status: 'invalid_cookie' };
  if (typeof expectedStudentId !== 'string' || !/^[A-Za-z0-9]{6,24}$/.test(expectedStudentId)) {
    return { status: 'invalid_student_id' };
  }

  try {
    const response = await fetchImpl(ACADEMIC_IDENTITY_URL, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
      headers: {
        accept: 'text/html,application/xhtml+xml',
        cookie: cookieHeader,
        referer: ACADEMIC_IDENTITY_URL,
        'user-agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 '
          + '(KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36'
      }
    });
    if (response.status >= 300 && response.status < 400) return { status: 'session_expired' };
    if (response.status === 401 || response.status === 403) return { status: 'school_rejected' };
    if (response.status !== 200) return { status: 'school_unavailable' };

    const identity = await readStudentId(response);
    if (identity.status !== 'verified') return { status: identity.status };
    const studentId = identity.studentId;
    return {
      status: 'verified',
      matchesLocal: studentId.toLowerCase() === expectedStudentId.toLowerCase(),
      maskedStudentId: maskedStudentId(studentId)
    };
  } catch {
    // School cookies and the upstream response must never reach error logs.
    return { status: 'network_error' };
  }
}

export { ACADEMIC_IDENTITY_URL, parseStudentId, probeSchoolIdentity, validCookieHeader };
