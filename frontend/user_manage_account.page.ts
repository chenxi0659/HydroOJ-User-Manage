const page = document.documentElement.dataset.page;

function createApiPath(name: string) {
  const suffix = '/home/settings/account';
  const base = location.pathname.endsWith(suffix)
    ? location.pathname.slice(0, -suffix.length)
    : '';
  return `${base}/home/account/${name}`;
}

async function accountRequest(path: string, data?: Record<string, unknown>) {
  const response = await fetch(path, {
    method: data ? 'POST' : 'GET',
    credentials: 'same-origin',
    headers: data ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' },
    body: data ? JSON.stringify(data) : undefined,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.error) throw new Error(body.error?.message || body.message || response.statusText);
  return body;
}

function removeLegacyAccountFields() {
  ['qq', 'school', 'studentId', 'phone'].forEach((key) => {
    const input = document.querySelector<HTMLElement>(`[name="${key}"]`);
    const container = input?.closest('.form__item') || input?.closest('.columns') || input?.parentElement;
    container?.remove();
  });
}

function mountAccountCards(profile: any) {
  const nativeForm = document.querySelector('.page--home_account form');
  const nativeSection = nativeForm?.closest('.section');
  if (!nativeSection) return;

  const section = document.createElement('div');
  section.className = 'section um-account-settings';
  section.innerHTML = `
    <div class="section__header"><h1 class="section__title">账户资料</h1></div>
    <div class="section__body">
      <form id="um-account-profile-form" class="um-account-form">
        <div class="row">
          <div class="medium-6 columns"><label>姓名<input class="textbox" name="realName"></label></div>
          <div class="medium-6 columns"><label>学号<input class="textbox" name="studentId"></label></div>
          <div class="medium-6 columns"><label>专业<input class="textbox" name="major"></label></div>
          <div class="medium-6 columns"><label>班级<input class="textbox" name="class"></label></div>
        </div>
        <label class="um-account-toggle"><input type="checkbox" name="showRealNameOnProfile"> 在我的资料展示姓名</label>
        <p class="um-account-readonly-note" hidden>Default 用户的姓名、学号、专业和班级由管理员统一维护。</p>
        <button type="submit" class="rounded primary button">保存账户资料</button>
      </form>
    </div>
    <div class="section__header"><h1 class="section__title">登录凭据</h1></div>
    <div class="section__body um-account-credentials">
      <form id="um-account-username-form" class="um-account-form">
        <h3>修改登录用户名</h3>
        <label>新用户名<input class="textbox" name="uname" required></label>
        <label>当前密码<input class="textbox" name="currentPassword" type="password" autocomplete="current-password" required></label>
        <button type="submit" class="rounded button">保存用户名</button>
      </form>
      <form id="um-account-email-form" class="um-account-form">
        <h3>修改邮箱</h3>
        <label>新邮箱<input class="textbox" name="mail" type="email" autocomplete="email" required></label>
        <label>当前密码<input class="textbox" name="currentPassword" type="password" autocomplete="current-password" required></label>
        <button type="submit" class="rounded button">保存邮箱</button>
      </form>
      <form id="um-account-password-form" class="um-account-form">
        <h3>修改登录密码</h3>
        <label>当前密码<input class="textbox" name="currentPassword" type="password" autocomplete="current-password" required></label>
        <label>新密码<input class="textbox" name="password" type="password" autocomplete="new-password" required></label>
        <label>再次输入新密码<input class="textbox" name="verifyPassword" type="password" autocomplete="new-password" required></label>
        <button type="submit" class="rounded button">修改密码</button>
      </form>
    </div>
  `;
  nativeSection.before(section);

  const profileForm = section.querySelector<HTMLFormElement>('#um-account-profile-form')!;
  const setValue = (name: string, value: string) => {
    const input = profileForm.elements.namedItem(name) as HTMLInputElement;
    input.value = value;
    if (profile.readOnly) {
      input.readOnly = true;
      input.classList.add('um-account-readonly');
    }
  };
  setValue('realName', profile.realName || '');
  setValue('studentId', profile.studentId || '');
  setValue('major', profile.major || '');
  setValue('class', profile.className || '');
  (profileForm.elements.namedItem('showRealNameOnProfile') as HTMLInputElement).checked = !!profile.showRealNameOnProfile;
  if (profile.readOnly) section.querySelector<HTMLElement>('.um-account-readonly-note')!.hidden = false;

  profileForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const fields = new FormData(profileForm);
    try {
      await accountRequest(createApiPath('profile'), {
        realName: String(fields.get('realName') || ''),
        studentId: String(fields.get('studentId') || ''),
        major: String(fields.get('major') || ''),
        class: String(fields.get('class') || ''),
        showRealNameOnProfile: fields.get('showRealNameOnProfile') === 'on',
      });
      alert('账户资料已保存。');
    } catch (error) { alert((error as Error).message); }
  });

  const usernameForm = section.querySelector<HTMLFormElement>('#um-account-username-form')!;
  (usernameForm.elements.namedItem('uname') as HTMLInputElement).value = profile.uname || '';
  usernameForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const fields = new FormData(usernameForm);
    try {
      await accountRequest(createApiPath('username'), {
        uname: String(fields.get('uname') || ''),
        currentPassword: String(fields.get('currentPassword') || ''),
      });
      alert('登录用户名已保存。');
      (usernameForm.elements.namedItem('currentPassword') as HTMLInputElement).value = '';
    } catch (error) { alert((error as Error).message); }
  });

  const emailForm = section.querySelector<HTMLFormElement>('#um-account-email-form')!;
  (emailForm.elements.namedItem('mail') as HTMLInputElement).value = profile.mail || '';
  emailForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const fields = new FormData(emailForm);
    try {
      await accountRequest(createApiPath('email'), {
        mail: String(fields.get('mail') || ''),
        currentPassword: String(fields.get('currentPassword') || ''),
      });
      alert('邮箱已保存。');
      (emailForm.elements.namedItem('currentPassword') as HTMLInputElement).value = '';
    } catch (error) { alert((error as Error).message); }
  });

  const passwordForm = section.querySelector<HTMLFormElement>('#um-account-password-form')!;
  passwordForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const fields = new FormData(passwordForm);
    try {
      const result = await accountRequest(createApiPath('password'), {
        currentPassword: String(fields.get('currentPassword') || ''),
        password: String(fields.get('password') || ''),
        verifyPassword: String(fields.get('verifyPassword') || ''),
      });
      alert('密码已修改，请重新登录。');
      location.assign(result.loginUrl || '/login');
    } catch (error) { alert((error as Error).message); }
  });
}

function installAccountStyles() {
  const style = document.createElement('style');
  style.textContent = `
    .um-account-form label { display:block; margin-bottom:12px; }
    .um-account-form .textbox { width:100%; max-width:none; }
    .um-account-credentials { display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:24px; }
    .um-account-credentials h3 { margin-top:0; }
    .um-account-readonly { background:#f1f3f5 !important; color:#7b8491 !important; cursor:not-allowed; }
    .um-account-readonly-note { color:#7b8491; font-size:12px; }
    .um-account-toggle { display:flex !important; gap:8px; align-items:center; }
    @media (max-width:767px) { .um-account-credentials { grid-template-columns:1fr; } }
  `;
  document.head.append(style);
}

async function initialiseAccountSettings() {
  if (page !== 'home_account') return;
  removeLegacyAccountFields();
  installAccountStyles();
  try {
    const profile = await accountRequest(createApiPath('profile'));
    mountAccountCards(profile);
  } catch (error) { console.error('Unable to initialise account settings', error); }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialiseAccountSettings, { once: true });
else initialiseAccountSettings();
