import {
    Context, Handler, param, PRIV, Types, UserModel, DomainModel,
    ValidationError, UserNotFoundError, PermissionError, SystemModel, moment
} from 'hydrooj';

declare module 'hydrooj' {
    interface Collections {
        // 扩展用户集合类型
    }
}

// ==================== 工具函数 ====================

function parseUidArray(raw: string | undefined): number[] {
    if (!raw) return [];
    try {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) return arr.map(Number).filter(n => !isNaN(n));
    } catch { /* fall through */ }
    return [];
}

function generateCSV(columns: string[], rows: string[][]): string {
    const escape = (val: string) => {
        const str = String(val);
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
            return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
    };
    const header = columns.map(escape).join(',');
    const body = rows.map(row => row.map(escape).join(',')).join('\n');
    return header + '\n' + body;
}

function getRegistrationType(udoc: any): string {
    if (udoc.registrationType === 'unified') return '统一注册';
    if (udoc.registrationType === 'self') return '主动注册';
    if (udoc.major?.trim() && udoc.class?.trim()) return '统一注册';
    return '主动注册';
}

type ImportUser = {
    uname: string;
    mail: string;
    password: string;
    school?: string;
    bio?: string;
    major?: string;
    class?: string;
};

function parseImportUsers(raw: string): ImportUser[] {
    try {
        const users = JSON.parse(raw);
        if (!Array.isArray(users)) throw new Error('Invalid user list');
        return users.map((user) => ({
            uname: String(user.uname || '').trim(),
            mail: String(user.mail || '').trim(),
            password: String(user.password || ''),
            school: String(user.school || '').trim(),
            bio: String(user.bio || '').trim(),
            major: String(user.major || '').trim(),
            class: String(user.class || '').trim(),
        }));
    } catch {
        throw new ValidationError('users', 'Invalid user list');
    }
}

async function validateImportUsers(domainId: string, users: ImportUser[]) {
    const errors: string[] = [];
    const mails = new Set<string>();
    const unames = new Set<string>();
    for (let index = 0; index < users.length; index++) {
        const user = users[index];
        const prefix = `第 ${index + 1} 行`;
        if (!Types.Email[1](user.mail)) errors.push(`${prefix}：邮箱格式无效`);
        if (!Types.Username[1](user.uname)) errors.push(`${prefix}：用户名格式无效`);
        if (!Types.Password[1](user.password)) errors.push(`${prefix}：密码格式无效`);
        if (mails.has(user.mail.toLowerCase())) errors.push(`${prefix}：邮箱在待确认名单中重复`);
        if (unames.has(user.uname.toLowerCase())) errors.push(`${prefix}：用户名在待确认名单中重复`);
        mails.add(user.mail.toLowerCase());
        unames.add(user.uname.toLowerCase());
        if (await UserModel.getByEmail(domainId, user.mail)) errors.push(`${prefix}：邮箱已存在`);
        if (await UserModel.getByUname(domainId, user.uname)) errors.push(`${prefix}：用户名已存在`);
    }
    return errors;
}

// ==================== 用户管理处理器基类 ====================

class UserManageHandler extends Handler {
    async prepare() {
        this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
    }
}

// ==================== 用户管理主页面处理器 ====================

class UserManageMainHandler extends UserManageHandler {
    @param('page', Types.PositiveInt, true)
    @param('search', Types.String, true)
    @param('sort', Types.String, true)
    @param('group', Types.String, true)
    @param('major', Types.String, true)
    @param('class', Types.String, true)
    async get(domainId: string, page = 1, search = '', sort = '_id', group = '', major = '', className = '') {
        const limit = 15;
        const query: any = {};

        // 分组筛选
        if (group) {
            if (group.startsWith('专业：')) {
                query.major = group.slice(3);
            } else if (group.startsWith('班级：')) {
                query.class = group.slice(3);
            } else {
                const gdocs = await UserModel.listGroup(domainId, undefined, [group]);
                if (gdocs.length > 0 && gdocs[0].uids.length > 0) query._id = { $in: gdocs[0].uids };
                else query._id = { $in: [] };
            }
        }

        // 专业、班级为用户文档的扩展字段；精确筛选后可批量选择整个班级。
        if (major) query.major = major;
        if (className) query.class = className;

        // 搜索功能
        if (search) {
            const searchRegex = new RegExp(search, 'i');
            const searchQuery: any[] = [
                { unameLower: searchRegex },
                { mailLower: searchRegex },
                { _id: isNaN(+search) ? undefined : +search }
            ].filter(Boolean);
            if (query._id) {
                query.$and = [{ _id: query._id }, { $or: searchQuery }];
                delete query._id;
            } else {
                query.$or = searchQuery;
            }
        }

        // 排序选项
        const sortOptions: Record<string, any> = {
            '_id': { _id: 1 },
            'uname': { uname: 1 },
            'regat': { regat: -1 },
            'loginat': { loginat: -1 },
            'priv': { priv: -1 }
        };

        const sortQuery = sortOptions[sort] || { _id: 1 };
        const pageParams = new URLSearchParams();
        if (search) pageParams.set('search', search);
        if (sort && sort !== '_id') pageParams.set('sort', sort);
        if (group) pageParams.set('group', group);
        if (major) pageParams.set('major', major);
        if (className) pageParams.set('class', className);

        // 获取用户列表
        const [udocs, upcount] = await this.paginate(
            UserModel.getMulti(query).sort(sortQuery),
            page,
            limit
        );

        // 仅在按班级筛选时取回该筛选结果的 ID，避免默认页面产生全量用户扫描。
        const classUids = className
            ? (await UserModel.getMulti(query, ['_id']).toArray()).map((udoc) => udoc._id)
            : [];

        // 获取用户在当前域的信息
        const duids = udocs.map(udoc => udoc._id);
        const dudocs = await DomainModel.getMultiUserInDomain(domainId, { uid: { $in: duids } }).toArray();
        const dudocMap = Object.fromEntries(dudocs.map(dudoc => [dudoc.uid, dudoc]));

        // 获取所有分组（用于分组筛选栏）
        const allGroups = await UserModel.listGroup(domainId);
        const groups = allGroups
            .filter(g => !/^\d+$/.test(g.name)) // 过滤掉系统自动生成的 uid 分组
            .map(g => ({ name: g.name, count: g.uids.length }));
        const majorGroups = groups.filter((g) => g.name.startsWith('专业：')).map((g) => ({ ...g, label: g.name.slice(3) }));
        const classGroups = groups.filter((g) => g.name.startsWith('班级：')).map((g) => ({ ...g, label: g.name.slice(3) }));

        this.response.template = 'user_manage_main.html';
        this.response.body = {
            udocs,
            dudocMap,
            page,
            upcount,
            search,
            sort,
            group,
            major,
            className,
            classUids,
            pageQs: pageParams.toString(),
            groups,
            majorGroups,
            classGroups,
            majorGroupWidth: Math.max(12, ...majorGroups.map((g) => g.name.length + 6)),
            classGroupWidth: Math.max(12, ...classGroups.map((g) => g.name.length + 6)),
            canEdit: true,
            moment
        };
    }
}

// ==================== 用户导出处理器 ====================

class UserManageExportHandler extends UserManageHandler {
    @param('uids', Types.String)
    async post(domainId: string, uids: string) {
        const uidArray = Array.from(new Set(parseUidArray(uids)));
        if (uidArray.length === 0) {
            throw new ValidationError('uids', 'No users selected');
        }

        // 获取用户数据
        const udocs = await UserModel.getMulti({ _id: { $in: uidArray } }).toArray();

        // 排序：同班级 → 同专业 → ID
        udocs.sort((a, b) => {
            const aClass = a.class || '￿';
            const bClass = b.class || '￿';
            const aMajor = a.major || '￿';
            const bMajor = b.major || '￿';
            if (aClass !== bClass) return aClass.localeCompare(bClass);
            if (aMajor !== bMajor) return aMajor.localeCompare(bMajor);
            return (a._id || 0) - (b._id || 0);
        });

        // 生成 CSV
        const columns = ['用户名', 'ID', '邮箱', '专业', '班级', '注册类型'];
        const rows = udocs.map(u => [
            u.uname || '',
            String(u._id),
            u.mail || '',
            u.major || '',
            u.class || '',
            getRegistrationType(u)
        ]);

        // BOM 由浏览器下载时添加，避免 CSV 首列表头出现重复的不可见字符。
        const csv = generateCSV(columns, rows);

        this.response.body = { csv };
    }
}

// ==================== 用户删除 ====================

class UserManageDeleteHandler extends UserManageHandler {
    @param('uids', Types.String)
    @param('password', Types.String)
    async post(domainId: string, uids: string, password: string) {
        const uidArray = Array.from(new Set(parseUidArray(uids)));
        if (uidArray.length === 0) throw new ValidationError('uids', 'No users selected');

        // 删除是不可逆的账户级操作：必须再次验证当前管理员密码。
        await this.user.checkPassword(password);

        const users = await UserModel.coll.find({ _id: { $in: uidArray } }).toArray();
        if (users.length !== uidArray.length) throw new ValidationError('uids', 'One or more users no longer exist');
        if (users.some((user) => user._id === this.user._id)) {
            throw new PermissionError('Cannot delete the active administrator account');
        }
        if (users.some((user) => user._id <= 1 || user.priv === PRIV.PRIV_ALL)) {
            throw new PermissionError('Cannot delete root account');
        }

        // 用户账户是全站共享的；同步移除所有域成员记录和所有用户组引用，
        // 但保留历史提交/记录，避免破坏题目、比赛和统计数据的关联完整性。
        await Promise.all([
            UserModel.coll.deleteMany({ _id: { $in: uidArray } }),
            DomainModel.collUser.deleteMany({ uid: { $in: uidArray } }),
            UserModel.collGroup.updateMany(
                { uids: { $in: uidArray } },
                { $pull: { uids: { $in: uidArray } } },
            ),
        ]);
        await UserModel.collGroup.deleteMany({
            uids: { $size: 0 },
            name: { $regex: /^(专业|班级)：/ },
        });
        for (const user of users) UserModel._deleteUserCache(user);
        await syncAttributeGroups(domainId);

        this.response.body = { success: true, count: users.length };
    }
}

// ==================== 分组管理处理器 ====================

class UserManageGroupsHandler extends UserManageHandler {
    async get(domainId: string) {
        const allGroups = await UserModel.listGroup(domainId);
        const groups = allGroups
            .filter(g => !/^\d+$/.test(g.name))
            .map(g => ({ name: g.name, count: g.uids.length }));
        this.response.body = { groups };
    }

    @param('name', Types.String, true)
    async postCreate(domainId: string, name?: string) {
        if (!name || !name.trim()) throw new ValidationError('name', 'Group name is required');
        const trimmed = name.trim();
        const existing = await UserModel.listGroup(domainId, undefined, [trimmed]);
        if (existing.length > 0) throw new ValidationError('name', 'Group already exists');
        await UserModel.updateGroup(domainId, trimmed, []);
        this.response.body = { success: true, name: trimmed };
    }

    @param('name', Types.String)
    async postDelete(domainId: string, name: string) {
        await UserModel.delGroup(domainId, name);
        this.response.body = { success: true };
    }

    @param('name', Types.String)
    @param('uids', Types.String)
    async postAddUsers(domainId: string, name: string, uids: string) {
        const uidArr = parseUidArray(uids);
        if (uidArr.length === 0) throw new ValidationError('uids', 'No users selected');
        const gdocs = await UserModel.listGroup(domainId, undefined, [name]);
        if (gdocs.length === 0) throw new ValidationError('name', 'Group not found');
        const merged = [...new Set([...(gdocs[0].uids || []), ...uidArr])];
        await UserModel.updateGroup(domainId, name, merged);
        this.response.body = { success: true, count: merged.length };
    }

    @param('name', Types.String)
    @param('uids', Types.String)
    async postRemoveUsers(domainId: string, name: string, uids: string) {
        const uidArr = parseUidArray(uids);
        if (uidArr.length === 0) throw new ValidationError('uids', 'No users selected');
        const gdocs = await UserModel.listGroup(domainId, undefined, [name]);
        if (gdocs.length === 0) throw new ValidationError('name', 'Group not found');
        const uidSet = new Set(uidArr);
        const filtered = (gdocs[0].uids || []).filter((id: number) => !uidSet.has(id));
        await UserModel.updateGroup(domainId, name, filtered);
        this.response.body = { success: true, count: filtered.length };
    }
}

async function syncAttributeGroups(domainId: string) {
    const additions = new Map<string, number[]>();
    const users = await UserModel.getMulti({}).toArray();
    for (const user of users) {
        const uid = user._id;
        const major = user.major?.trim();
        const className = user.class?.trim();
        if (major) additions.set(`专业：${major}`, [...(additions.get(`专业：${major}`) || []), uid]);
        if (className) additions.set(`班级：${className}`, [...(additions.get(`班级：${className}`) || []), uid]);
    }
    const existing = await UserModel.listGroup(domainId);
    for (const group of existing.filter((item) => item.name.startsWith('专业：') || item.name.startsWith('班级：'))) {
        if (!additions.has(group.name)) await UserModel.delGroup(domainId, group.name);
    }
    for (const [name, uids] of additions) {
        await UserModel.updateGroup(domainId, name, Array.from(new Set(uids)));
    }
}

// ==================== 批量添加用户 ====================

class UserManageImportHandler extends UserManageHandler {
    async get() {
        this.response.template = 'user_manage_import.html';
        this.response.body = { defaultPriv: await SystemModel.get('default.priv') };
    }

    @param('users', Types.String)
    async postValidate(domainId: string, rawUsers: string) {
        const users = parseImportUsers(rawUsers);
        const errors = await validateImportUsers(domainId, users);
        this.response.body = { valid: errors.length === 0, errors };
    }

    @param('users', Types.String)
    async postCreate(domainId: string, rawUsers: string) {
        const users = parseImportUsers(rawUsers);
        const errors = await validateImportUsers(domainId, users);
        if (errors.length) throw new ValidationError('users', errors.join('\n'));
        const created: Array<ImportUser & { uid: number }> = [];
        const defaultPriv = await SystemModel.get('default.priv');
        for (const user of users) {
            const uid = await UserModel.create(user.mail, user.uname, user.password, undefined, this.request.ip, defaultPriv);
            await UserModel.setById(uid, {
                school: user.school || '', bio: user.bio || '', major: user.major || '', class: user.class || '',
            });
            created.push({ ...user, uid });
        }
        await syncAttributeGroups(domainId);
        this.response.body = { success: true, count: created.length, defaultPriv };
    }
}

class UserManageAutoGroupHandler extends UserManageHandler {
    async post(domainId: string) {
        const count = (await UserModel.getMulti({}, ['_id']).toArray()).length;
        await syncAttributeGroups(domainId);
        this.response.body = { success: true, count };
    }
}

// ==================== 用户详情和编辑处理器 ====================

class UserManageDetailHandler extends UserManageHandler {
    @param('uid', Types.Int)
    async get(domainId: string, uid: number) {
        const [udoc, rawUdocs] = await Promise.all([
            UserModel.getById(domainId, uid),
            UserModel.getMulti({ _id: uid }).toArray(),
        ]);
        if (!udoc) throw new UserNotFoundError(uid);
        const profile = rawUdocs[0] || {};

        const dudoc = await DomainModel.getDomainUser(domainId, udoc);

        this.response.template = 'user_manage_detail.html';
        this.response.body = {
            udoc,
            profile,
            registrationType: getRegistrationType(profile),
            registrationTypeValue: profile.registrationType || (profile.major?.trim() && profile.class?.trim() ? 'unified' : 'self'),
            dudoc,
            canEdit: true,
            moment
        };
    }

    @param('uid', Types.Int)
    @param('mail', Types.Email, true)
    @param('uname', Types.Username, true)
    @param('school', Types.String, true)
    @param('bio', Types.Content, true)
    @param('major', Types.String, true)
    @param('class', Types.String, true)
    @param('registrationType', Types.String, true)
    async postEdit(domainId: string, uid: number, mail?: string, uname?: string, school?: string, bio?: string, major?: string, newClass?: string, registrationType?: string) {
        const udoc = await UserModel.getById(domainId, uid);
        if (!udoc) throw new UserNotFoundError(uid);

        if (mail && mail !== udoc.mail) {
            const existing = await UserModel.getByEmail(domainId, mail);
            if (existing && existing._id !== uid) {
                throw new ValidationError('mail', 'Email already in use');
            }
            await UserModel.setEmail(uid, mail);
        }

        if (uname && uname !== udoc.uname) {
            const existing = await UserModel.getByUname(domainId, uname);
            if (existing && existing._id !== uid) {
                throw new ValidationError('uname', 'Username already in use');
            }
            await UserModel.setUname(uid, uname);
        }

        const updates: any = {};
        if (school !== undefined) updates.school = school;
        if (bio !== undefined) updates.bio = bio;
        if (major !== undefined) updates.major = major.trim();
        if (newClass !== undefined) updates.class = newClass.trim();
        if (registrationType !== undefined) {
            if (!['self', 'unified'].includes(registrationType)) throw new ValidationError('registrationType', 'Invalid registration type');
            updates.registrationType = registrationType;
        }

        if (Object.keys(updates).length > 0) {
            await UserModel.setById(uid, updates);
            await syncAttributeGroups(domainId);
        }
        this.back();
    }

    @param('uid', Types.Int)
    @param('major', Types.String, true)
    @param('class', Types.String, true)
    async postUpdateFields(domainId: string, uid: number, major?: string, newClass?: string) {
        const udoc = await UserModel.getById(domainId, uid);
        if (!udoc) throw new UserNotFoundError(uid);

        const updates: any = {};
        if (major !== undefined) updates.major = major.trim();
        if (newClass !== undefined) updates.class = newClass.trim();

        if (Object.keys(updates).length > 0) {
            await UserModel.setById(uid, updates);
            await syncAttributeGroups(domainId);
        }
        this.back();
    }

    @param('uid', Types.Int)
    @param('password', Types.Password)
    async postResetPassword(domainId: string, uid: number, password: string) {
        const udoc = await UserModel.getById(domainId, uid);
        if (!udoc) throw new UserNotFoundError(uid);

        if (udoc.priv === PRIV.PRIV_ALL && this.user.priv !== PRIV.PRIV_ALL) {
            throw new PermissionError('Cannot reset super admin password');
        }

        await UserModel.setPassword(uid, password);
        this.back();
    }

    @param('uid', Types.Int)
    @param('priv', Types.Int)
    async postSetPriv(domainId: string, uid: number, priv: number) {
        const udoc = await UserModel.getById(domainId, uid);
        if (!udoc) throw new UserNotFoundError(uid);

        if ((udoc.priv === PRIV.PRIV_ALL || priv === PRIV.PRIV_ALL) && this.user.priv !== PRIV.PRIV_ALL) {
            throw new PermissionError('Cannot modify super admin privileges');
        }

        await UserModel.setPriv(uid, priv);
        this.back();
    }

    @param('uid', Types.Int)
    async postBan(domainId: string, uid: number) {
        const udoc = await UserModel.getById(domainId, uid);
        if (!udoc) throw new UserNotFoundError(uid);

        if (udoc.priv === PRIV.PRIV_ALL) {
            throw new PermissionError('Cannot ban super admin');
        }

        await UserModel.ban(uid, 'Banned by administrator');
        this.back();
    }

    @param('uid', Types.Int)
    async postUnban(domainId: string, uid: number) {
        const udoc = await UserModel.getById(domainId, uid);
        if (!udoc) throw new UserNotFoundError(uid);

        const defaultPriv = await SystemModel.get('default.priv');
        await UserModel.setPriv(uid, defaultPriv);
        this.back();
    }
}


// ==================== 插件入口 ====================

export async function apply(ctx: Context) {
    // 注意：具体路由必须在 /manage/users/:uid 之前注册，避免被 :uid 拦截
    ctx.Route('user_manage_export', '/manage/users/export', UserManageExportHandler, PRIV.PRIV_EDIT_SYSTEM);
    ctx.Route('user_manage_delete', '/manage/users/delete', UserManageDeleteHandler, PRIV.PRIV_EDIT_SYSTEM);
    ctx.Route('user_manage_groups', '/manage/users/groups', UserManageGroupsHandler, PRIV.PRIV_EDIT_SYSTEM);
    ctx.Route('user_manage_auto_group', '/manage/users/auto-group', UserManageAutoGroupHandler, PRIV.PRIV_EDIT_SYSTEM);
    ctx.Route('user_manage_import', '/manage/users/import', UserManageImportHandler, PRIV.PRIV_EDIT_SYSTEM);

    // 页面路由
    ctx.Route('user_manage_main', '/manage/users', UserManageMainHandler, PRIV.PRIV_EDIT_SYSTEM);
    ctx.Route('user_manage_detail', '/manage/users/:uid', UserManageDetailHandler, PRIV.PRIV_EDIT_SYSTEM);

    // 注入控制面板菜单
    ctx.injectUI('ControlPanel', 'user_manage_main', { icon: 'user' });

    // ==================== 国际化 ====================

    ctx.i18n.load('zh', {
        'user_manage_main': '用户管理',
        'user_manage_detail': '用户详情',

        'User Management': '用户管理',
        'User List': '用户列表',
        'Search Users': '搜索用户',
        'Search by': '搜索方式',
        'Username': '用户名',
        'Email': '邮箱',
        'User ID': '用户ID',
        'Keyword': '关键词',
        'Sort by': '排序方式',
        'Registration Time': '注册时间',
        'Last Login': '最后登录',
        'Privilege': '权限',
        'Order': '顺序',
        'Ascending': '升序',
        'Descending': '降序',
        'Search': '搜索',
        'Clear': '清空',
        'Refresh': '刷新',

        'Normal User': '普通用户',
        'Admin': '管理员',
        'Banned': '已封禁',
        'Super Admin': '超级管理员',
        'Active': '活跃',
        'Inactive': '不活跃',
        'Actions': '操作',
        'View': '查看',
        'Edit': '编辑',
        'Ban': '封禁',
        'Unban': '解封',
        'Set Privilege': '设置权限',
        'Status': '状态',
        'School': '学校',
        'Bio': '个人简介',
        'Never': '从未',
        'Not set': '未设置',
        'Previous': '上一页',
        'Next': '下一页',
        'Page': '页',
        'of': '共',
        'users': '用户',
        'Total': '总计',
        'Showing': '显示',
        'to': '到',
        'User Details': '用户详情',
        'Basic Information': '基本信息',
        'User Statistics': '用户统计',
        'Privilege Management': '权限管理',
        'Password Management': '密码管理',
        'User Status': '用户状态',
        'Back to List': '返回列表',
        'Save Changes': '保存更改',
        'Cancel': '取消',
        'Reset Password': '重置密码',
        'Current Privilege': '当前权限',
        'Ban User': '封禁用户',
        'Unban User': '解封用户',
        'Copy User ID': '复制用户ID',

        // 新增：导出和分组
        'Export Selected': '导出选中',
        'Delete Selected': '删除选中',
        'Clear Major': '清空专业',
        'Clear Class': '清空班级',
        'Export CSV': '导出CSV',
        'Select All': '全选',
        'Deselect All': '取消全选',
        'Select All Filtered': '选择当前筛选结果',
        'Group Filter': '分组筛选',
        'All Users': '全部用户',
        'Create Group': '新建分组',
        'Delete Group': '删除分组',
        'Add to Group': '加入分组',
        'Remove from Group': '移出分组',
        'Group name': '分组名称',
        'Enter group name': '请输入分组名称',
        'Major': '专业',
        'Class': '班级',
        'Registration Type': '注册类型',
        'Unified Registration': '统一注册',
        'Self Registration': '主动注册',
        'No users selected': '未选择用户',
        'One or more users no longer exist': '部分用户已不存在，请刷新页面后重试',
        'Cannot delete the active administrator account': '不能删除当前正在操作的管理员账户',
        'Cannot delete root account': '不能删除 root 账户',
        'Export completed': '导出完成',
        'Group created': '分组创建成功',
        'Group deleted': '分组已删除',
        'Users added to group': '用户已加入分组',
        'Users removed from group': '用户已移出分组',
        'Are you sure to delete group {0}?': '确定要删除分组 {0} 吗？',
        '{count} users selected': '已选择 {count} 个用户',
        'Edit Major/Class': '编辑专业/班级',
    });

    ctx.i18n.load('en', {
        'user_manage_main': 'User Management',
        'user_manage_detail': 'User Detail',
        'user_manage_batch': 'Batch Operations',
        'User Management': 'User Management',
        'User List': 'User List',
        'Search Users': 'Search Users',
        'Search by': 'Search by',
        'Username': 'Username',
        'Email': 'Email',
        'User ID': 'User ID',
        'Keyword': 'Keyword',
        'Sort by': 'Sort by',
        'Registration Time': 'Registration Time',
        'Last Login': 'Last Login',
        'Privilege': 'Privilege',
        'Order': 'Order',
        'Ascending': 'Ascending',
        'Descending': 'Descending',
        'Search': 'Search',
        'Clear': 'Clear',
        'Refresh': 'Refresh',
        'Batch Operations': 'Batch Operations',
        'Export Users': 'Export Users',
        'Normal User': 'Normal User',
        'Admin': 'Admin',
        'Banned': 'Banned',
        'Super Admin': 'Super Admin',
        'Active': 'Active',
        'Inactive': 'Inactive',
        'Actions': 'Actions',
        'View': 'View',
        'Edit': 'Edit',
        'Ban': 'Ban',
        'Unban': 'Unban',
        'Set Privilege': 'Set Privilege',
        'Status': 'Status',
        'School': 'School',
        'Bio': 'Bio',
        'Never': 'Never',
        'Not set': 'Not set',
        'Previous': 'Previous',
        'Next': 'Next',
        'Page': 'Page',
        'of': 'of',
        'users': 'users',
        'Total': 'Total',
        'Showing': 'Showing',
        'to': 'to',
        'User Details': 'User Details',
        'Basic Information': 'Basic Information',
        'User Statistics': 'User Statistics',
        'Privilege Management': 'Privilege Management',
        'Password Management': 'Password Management',
        'User Status': 'User Status',
        'Back to List': 'Back to List',
        'Save Changes': 'Save Changes',
        'Cancel': 'Cancel',
        'Reset Password': 'Reset Password',
        'Current Privilege': 'Current Privilege',
        'Ban User': 'Ban User',
        'Unban User': 'Unban User',
        'Copy User ID': 'Copy User ID',

        // New: export and groups
        'Export Selected': 'Export Selected',
        'Delete Selected': 'Delete Selected',
        'Clear Major': 'Clear Major',
        'Clear Class': 'Clear Class',
        'Export CSV': 'Export CSV',
        'Select All': 'Select All',
        'Deselect All': 'Deselect All',
        'Select All Filtered': 'Select All Filtered',
        'Group Filter': 'Group Filter',
        'All Users': 'All Users',
        'Create Group': 'Create Group',
        'Delete Group': 'Delete Group',
        'Add to Group': 'Add to Group',
        'Remove from Group': 'Remove from Group',
        'Group name': 'Group name',
        'Enter group name': 'Enter group name',
        'Major': 'Major',
        'Class': 'Class',
        'Registration Type': 'Registration Type',
        'Unified Registration': 'Unified Registration',
        'Self Registration': 'Self Registration',
        'No users selected': 'No users selected',
        'One or more users no longer exist': 'One or more users no longer exist. Refresh and try again.',
        'Cannot delete the active administrator account': 'Cannot delete the active administrator account',
        'Cannot delete root account': 'Cannot delete root account',
        'Export completed': 'Export completed',
        'Group created': 'Group created',
        'Group deleted': 'Group deleted',
        'Users added to group': 'Users added to group',
        'Users removed from group': 'Users removed from group',
        'Are you sure to delete group {0}?': 'Are you sure to delete group {0}?',
        '{count} users selected': '{count} users selected',
        'Edit Major/Class': 'Edit Major/Class',
    });
}
