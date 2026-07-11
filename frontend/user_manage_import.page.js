import $ from 'jquery';
import Notification from 'vj/components/notification';
import { NamedPage } from 'vj/misc/Page';
import { request } from 'vj/utils';

const page = new NamedPage('user_manage_import', () => {
  const pending = [];
  const $table = $('#pending-users-table tbody');
  const $messages = $('#import-messages');
  const defaultPriv = $('#user-import-page').data('default-priv');

  const escape = (value) => $('<div>').text(value || '').html();
  const typeOf = (user) => user.major && user.class ? '统一注册' : '主动注册';

  function render() {
    if (!pending.length) $table.html('<tr class="empty"><td colspan="7">暂无待确认用户</td></tr>');
    else $table.html(pending.map((user, index) => `<tr><td>${escape(user.uname)}</td><td>${escape(user.mail)}</td><td>${escape(user.major)}</td><td>${escape(user.class)}</td><td>${typeOf(user)}</td><td>Default (${defaultPriv})</td><td><button type="button" class="rounded button pending-delete" data-index="${index}">删除</button></td></tr>`).join(''));
    $('#confirm-users-btn').prop('disabled', !pending.length);
  }

  function addUsers(users) {
    pending.push(...users.map((user) => ({
      uname: String(user.uname || '').trim(), mail: String(user.mail || '').trim(), password: String(user.password || ''),
      school: String(user.school || '').trim(), bio: String(user.bio || '').trim(), major: String(user.major || '').trim(), class: String(user.class || '').trim(),
    })));
    render();
  }

  function parseCsv(text) {
    const rows = []; let row = []; let cell = ''; let quoted = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '"' && text[i + 1] === '"' && quoted) { cell += '"'; i++; }
      else if (ch === '"') quoted = !quoted;
      else if (ch === ',' && !quoted) { row.push(cell.trim()); cell = ''; }
      else if ((ch === '\n' || ch === '\r') && !quoted) { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell.trim()); if (row.some(Boolean)) rows.push(row); row = []; cell = ''; }
      else cell += ch;
    }
    row.push(cell.trim()); if (row.some(Boolean)) rows.push(row);
    if (!rows.length) return [];
    const header = rows[0].map((value) => value.toLowerCase());
    const hasHeader = header.includes('用户名') || header.includes('username') || header.includes('邮箱') || header.includes('email');
    const index = (names, fallback) => { const found = header.findIndex((value) => names.includes(value)); return found >= 0 ? found : fallback; };
    const data = hasHeader ? rows.slice(1) : rows;
    return data.map((row) => hasHeader ? ({
      uname: row[index(['用户名', 'username', 'uname'], 0)], mail: row[index(['邮箱', 'email', 'mail'], 1)], password: row[index(['密码', 'password'], 2)],
      major: row[index(['专业', 'major'], 3)], class: row[index(['班级', 'class'], 4)],
    }) : ({ mail: row[0], uname: row[1], password: row[2], major: row[3], class: row[4] }));
  }

  $('#add-user-btn').on('click', () => { $('#add-user-form')[0].reset(); $('#add-user-dialog').show(); });
  $('#cancel-add-user-btn').on('click', () => $('#add-user-dialog').hide());
  $('#add-user-form').on('submit', (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    addUsers([Object.fromEntries(form.entries())]);
    $('#add-user-dialog').hide();
  });
  $('#switch-import-mode-btn').on('click', () => $('#csv-import-panel').toggle());
  $('#csv-file').on('change', (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => $('#csv-text').val(reader.result);
    reader.readAsText(file, 'utf-8');
  });
  $('#parse-csv-btn').on('click', () => {
    const users = parseCsv($('#csv-text').val());
    if (!users.length) return Notification.error('未识别到有效 CSV 记录。');
    addUsers(users); Notification.success(`已加入 ${users.length} 名待确认用户。`);
  });
  $table.on('click', '.pending-delete', function () {
    const index = Number($(this).data('index'));
    if (!confirm(`确定从待确认名单删除用户“${pending[index].uname}”吗？`)) return;
    pending.splice(index, 1); render();
  });
  $('#confirm-users-btn').on('click', async () => {
    try {
      const users = JSON.stringify(pending);
      const preview = await request.post('', { operation: 'validate', users });
      if (!preview.valid) { $messages.text(preview.errors.join('\n')); return Notification.error('校验未通过，请修正待确认名单。'); }
      if (!confirm(`确定创建 ${pending.length} 名用户吗？此操作将同时更新专业和班级分组。`)) return;
      const result = await request.post('', { operation: 'create', users });
      Notification.success(`已创建 ${result.count} 名用户。`); pending.length = 0; render(); $messages.text('创建完成。');
    } catch (error) { Notification.error(error.message); }
  });
  render();
});

export default page;
