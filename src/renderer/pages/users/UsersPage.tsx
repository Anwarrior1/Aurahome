import { useState, type ReactElement } from 'react'
import { ChevronDown, Pencil, Trash2 } from 'lucide-react'
import { useQuery } from '@renderer/lib/useQuery'
import { call, ApiError } from '@renderer/lib/api'
import { useToast } from '@renderer/lib/toast'
import { useSession } from '@renderer/state/session.store'
import { Badge, Button, Card, DataTable, ErrorNote, Field, Input, Modal, PageHeader, Select } from '@renderer/components/ui'
import { PERMISSION_KEYS as P, PERMISSION_SECTIONS, type PermissionSection } from '@shared/permissions/permission-keys'

interface User { id: number; username: string; fullName: string; roleId: number; roleName: string; isAdmin: boolean; active: boolean }
interface Role { id: number; name: string; isAdmin: boolean; permissions: string[]; userCount: number }
interface Permission {
  key: string
  module: string
  action: string
  section: PermissionSection
  label: string
  sensitive: boolean
}

export function UsersPage(): ReactElement {
  const { can } = useSession()
  const toast = useToast()
  const [user, setUser] = useState<{ id?: number; username: string; fullName: string; roleId: string; password: string; active: boolean } | undefined>()
  const [role, setRole] = useState<{ id?: number; name: string; permissions: string[]; isAdmin?: boolean } | undefined>()
  const [openPermissionSection, setOpenPermissionSection] = useState<PermissionSection | null>('dashboard')
  const [error, setError] = useState<string>()
  const [deleteRoleDialog, setDeleteRoleDialog] = useState<{ row: Role; confirmation: string; error?: string }>()

  const users = useQuery<User[]>('admin', 'users')
  const roles = useQuery<Role[]>('admin', 'roles')
  const permissions = useQuery<Permission[]>('admin', 'permissions')

  const bySection = new Map<PermissionSection, Permission[]>()
  for (const permission of permissions.data ?? []) {
    bySection.set(permission.section, [...(bySection.get(permission.section) ?? []), permission])
  }

  async function saveUser(): Promise<void> {
    if (!user?.username.trim() || !user.fullName.trim() || !user.roleId) { setError('كل الحقول مطلوبة'); return }
    try {
      if (user.id) {
        await call('admin', 'updateUser', {
          id: user.id, fullName: user.fullName, roleId: Number(user.roleId),
          active: user.active, password: user.password || undefined
        })
      } else {
        await call('admin', 'createUser', {
          username: user.username, password: user.password, fullName: user.fullName, roleId: Number(user.roleId)
        })
      }
      toast.show('تم حفظ المستخدم', 'success')
      setUser(undefined); setError(undefined)
      await users.reload()
    } catch (err) { setError(err instanceof ApiError ? err.message : 'تعذر الحفظ') }
  }

  async function saveRole(): Promise<void> {
    if (!role?.name.trim()) { setError('اسم الدور مطلوب'); return }
    try {
      if (role.id) await call('admin', 'updateRole', { id: role.id, name: role.name, permissions: role.isAdmin ? undefined : role.permissions })
      else await call('admin', 'createRole', { name: role.name, permissions: role.permissions })
      toast.show('تم حفظ الدور وصلاحياته', 'success')
      setRole(undefined); setError(undefined)
      await roles.reload()
    } catch (err) { setError(err instanceof ApiError ? err.message : 'تعذر الحفظ') }
  }

  /**
   * Deleting a user is its own, independent operation — it never
   * touches the user's role or that role's permissions, and the role
   * stays fully intact and listed even at zero users. Reloading both
   * queries afterward keeps the Roles table's own "المستخدمون" count
   * from showing a stale, pre-delete number.
   */
  async function removeUser(row: User): Promise<void> {
    if (!window.confirm('هل أنت متأكد من حذف هذا المستخدم نهائيًا؟ لا يمكن التراجع عن هذا الإجراء.')) return
    try {
      await call('admin', 'deleteUser', { id: row.id })
      toast.show('تم حذف المستخدم', 'success')
      await Promise.all([users.reload(), roles.reload()])
    } catch (err) {
      toast.show(err instanceof ApiError ? err.message : 'تعذر حذف المستخدم', 'error')
    }
  }

  /**
   * Deleting a role never deletes or touches any user — it only ever
   * removes the role's own role_permissions along with it, and only
   * when truly unused. The live, just-reloaded user count (never a
   * value the table happened to render earlier) decides whether this
   * goes straight to the typed-name confirmation or to the existing
   * "still assigned" message — so an unused role never gets stuck
   * behind a stale "in use" impression from before its last user was
   * removed.
   */
  async function removeRole(row: Role): Promise<void> {
    try {
      // Fetched directly (not read back from the `roles` hook's own
      // state, which would still be this render's stale closure right
      // after calling reload()) so the decision below is always made
      // on the database's current state, never a previously-rendered one.
      const fresh = (await call<Role[]>('admin', 'roles')).find((r) => r.id === row.id) ?? row
      if (fresh.userCount > 0) {
        toast.show('لا يمكن حذف هذا الدور لأنه مرتبط بمستخدمين. غيّر أدوار المستخدمين أولاً.', 'error')
        return
      }
      setDeleteRoleDialog({ row: fresh, confirmation: '' })
    } catch (err) {
      toast.show(err instanceof ApiError ? err.message : 'تعذر فحص الدور', 'error')
    }
  }

  async function deleteRoleFromDialog(): Promise<void> {
    if (!deleteRoleDialog) return
    if (deleteRoleDialog.confirmation.trim() !== deleteRoleDialog.row.name.trim()) {
      setDeleteRoleDialog({ ...deleteRoleDialog, error: `اكتب: ${deleteRoleDialog.row.name}` })
      return
    }
    try {
      await call('admin', 'deleteRole', { id: deleteRoleDialog.row.id, confirmation: deleteRoleDialog.confirmation })
      toast.show('تم حذف الدور', 'success')
      setDeleteRoleDialog(undefined)
      await roles.reload()
    } catch (err) {
      setDeleteRoleDialog({ ...deleteRoleDialog, error: err instanceof ApiError ? err.message : 'تعذر حذف الدور' })
    }
  }

  function togglePermission(key: string): void {
    if (!role) return
    setRole({
      ...role,
      permissions: role.permissions.includes(key)
        ? role.permissions.filter((p) => p !== key)
        : [...role.permissions, key]
    })
  }

  function setSectionPermissions(section: PermissionSection, selected: boolean): void {
    if (!role) return
    const keys = new Set((bySection.get(section) ?? []).map((permission) => permission.key))
    setRole({
      ...role,
      permissions: selected
        ? [...new Set([...role.permissions, ...keys])]
        : role.permissions.filter((permission) => !keys.has(permission))
    })
  }

  return (
    <>
      <PageHeader
        title="المستخدمون والأدوار"
        subtitle="الصلاحيات تُطبَّق في طبقة الخدمات وليس بإخفاء الأزرار فقط"
        actions={<>
          {can(P.roles.manage) && <Button variant="secondary" onClick={() => { setRole({ name: '', permissions: [] }); setError(undefined) }}>+ دور جديد</Button>}
          {can(P.users.manage) && <Button onClick={() => { setUser({ username: '', fullName: '', roleId: '', password: '', active: true }); setError(undefined) }}>+ مستخدم جديد</Button>}
        </>}
      />

      <Card title="المستخدمون">
        <DataTable
          loading={users.loading}
          rows={users.data ?? []}
          rowKey={(row) => row.id}
          columns={[
            { key: 'username', header: 'اسم المستخدم', render: (row) => row.username },
            { key: 'name', header: 'الاسم', render: (row) => row.fullName },
            { key: 'role', header: 'الدور', render: (row) => <Badge tone={row.isAdmin ? 'info' : 'neutral'}>{row.roleName}</Badge> },
            { key: 'active', header: 'الحالة', render: (row) => <Badge tone={row.active ? 'success' : 'danger'}>{row.active ? 'نشط' : 'معطّل'}</Badge> },
            {
              key: 'actions', header: '', render: (row) => can(P.users.manage) ? (
                <div className="row-actions">
                  <button type="button" className="icon-btn" title="تعديل" aria-label="تعديل" onClick={() => { setUser({ id: row.id, username: row.username, fullName: row.fullName, roleId: String(row.roleId), password: '', active: row.active }); setError(undefined) }}>
                    <Pencil size={15} strokeWidth={2.25} aria-hidden="true" />
                  </button>
                  <button type="button" className="icon-btn icon-btn--danger" title="حذف المستخدم" aria-label="حذف المستخدم" onClick={() => void removeUser(row)}>
                    <Trash2 size={15} strokeWidth={2.25} aria-hidden="true" />
                  </button>
                </div>
              ) : null
            }
          ]}
        />
      </Card>

      <Card title="الأدوار والصلاحيات">
        <DataTable
          loading={roles.loading}
          rows={roles.data ?? []}
          rowKey={(row) => row.id}
          columns={[
            { key: 'name', header: 'الدور', render: (row) => row.name },
            { key: 'admin', header: '', render: (row) => (row.isAdmin ? <Badge tone="info">مدير النظام — كل الصلاحيات</Badge> : null) },
            { key: 'perms', header: 'عدد الصلاحيات', numeric: true, render: (row) => String(row.permissions.length) },
            { key: 'users', header: 'المستخدمون', numeric: true, render: (row) => String(row.userCount) },
            {
              key: 'actions', header: '', render: (row) => can(P.roles.manage) && !row.isAdmin ? (
                <div className="row-actions">
                  <Button variant="ghost" size="sm" onClick={() => { setRole({ id: row.id, name: row.name, permissions: row.permissions, isAdmin: row.isAdmin }); setError(undefined) }}>الصلاحيات</Button>
                  <button type="button" className="icon-btn icon-btn--danger" title="حذف الدور" aria-label="حذف الدور" onClick={() => void removeRole(row)}>
                    <Trash2 size={15} strokeWidth={2.25} aria-hidden="true" />
                  </button>
                </div>
              ) : null
            }
          ]}
        />
      </Card>

      <Modal open={Boolean(user)} title={user?.id ? 'تعديل مستخدم' : 'مستخدم جديد'} onClose={() => setUser(undefined)}
        footer={<><Button onClick={() => void saveUser()}>حفظ</Button><Button variant="secondary" onClick={() => setUser(undefined)}>إلغاء</Button></>}>
        <ErrorNote>{error}</ErrorNote>
        <Field label="اسم المستخدم" required>
          <Input value={user?.username ?? ''} disabled={Boolean(user?.id)} onChange={(e) => setUser({ ...user!, username: e.target.value })} />
        </Field>
        <Field label="الاسم الكامل" required><Input value={user?.fullName ?? ''} onChange={(e) => setUser({ ...user!, fullName: e.target.value })} /></Field>
        <Field label="الدور" required>
          <Select value={user?.roleId ?? ''} onChange={(e) => setUser({ ...user!, roleId: e.target.value })}>
            <option value="">— اختر —</option>
            {(roles.data ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </Select>
        </Field>
        <Field label={user?.id ? 'كلمة مرور جديدة (اختياري)' : 'كلمة المرور'} required={!user?.id} hint="6 أحرف على الأقل">
          <Input type="password" value={user?.password ?? ''} onChange={(e) => setUser({ ...user!, password: e.target.value })} />
        </Field>
        {user?.id && (
          <label className="checkbox-row">
            <input type="checkbox" checked={user.active} onChange={(e) => setUser({ ...user, active: e.target.checked })} />
            <span>الحساب نشط</span>
          </label>
        )}
      </Modal>

      <Modal open={Boolean(role)} wide title={role?.id ? `صلاحيات: ${role.name}` : 'دور جديد'} onClose={() => setRole(undefined)}
        footer={<><Button onClick={() => void saveRole()}>حفظ</Button><Button variant="secondary" onClick={() => setRole(undefined)}>إلغاء</Button></>}>
        <ErrorNote>{error}</ErrorNote>
        <Field label="اسم الدور" required><Input value={role?.name ?? ''} onChange={(e) => setRole({ ...role!, name: e.target.value })} /></Field>
        <p className="muted">اختر الصلاحيات الممنوحة لهذا الدور. الحقول الحساسة (التكاليف، الأرباح، المالية، الاستعادة) صلاحيات منفصلة.</p>
        <div className="permission-sections">
          {PERMISSION_SECTIONS.map((section) => {
            const items = bySection.get(section.key) ?? []
            if (!items.length) return null
            const isOpen = openPermissionSection === section.key
            const selectedCount = items.filter((permission) => role?.permissions.includes(permission.key)).length
            return (
              <section key={section.key} className={`permission-section ${isOpen ? 'permission-section--open' : ''}`}>
                <button
                  type="button"
                  className="permission-section__header"
                  aria-expanded={isOpen}
                  onClick={() => setOpenPermissionSection(isOpen ? null : section.key)}
                >
                  <span>{section.label}</span>
                  <span className="permission-section__count">{selectedCount}/{items.length}</span>
                  <ChevronDown size={16} aria-hidden="true" />
                </button>
                {isOpen && (
                  <div className="permission-section__body">
                    <div className="permission-section__controls">
                      <Button type="button" size="sm" variant="ghost" onClick={() => setSectionPermissions(section.key, true)}>تحديد الكل</Button>
                      <Button type="button" size="sm" variant="ghost" onClick={() => setSectionPermissions(section.key, false)}>إلغاء تحديد الكل</Button>
                    </div>
                    <div className="perm-grid">
                      {items.map((permission) => (
                        <label key={permission.key} className="perm-item">
                          <input
                            type="checkbox"
                            checked={role?.permissions.includes(permission.key) ?? false}
                            onChange={() => togglePermission(permission.key)}
                          />
                          <span>{permission.label}</span>
                          {permission.sensitive && <Badge tone="warning">حساسة</Badge>}
                        </label>
                      ))}
                    </div>
                  </div>
                )}
              </section>
            )
          })}
        </div>
      </Modal>

      <Modal
        open={Boolean(deleteRoleDialog)}
        title="حذف الدور نهائيًا"
        onClose={() => setDeleteRoleDialog(undefined)}
        footer={<>
          <Button
            variant="destructive"
            disabled={deleteRoleDialog?.confirmation.trim() !== deleteRoleDialog?.row.name.trim()}
            onClick={() => void deleteRoleFromDialog()}
          >
            حذف نهائي
          </Button>
          <Button variant="secondary" onClick={() => setDeleteRoleDialog(undefined)}>إلغاء</Button>
        </>}
      >
        <ErrorNote>{deleteRoleDialog?.error}</ErrorNote>
        <p>أنت على وشك حذف الدور «{deleteRoleDialog?.row.name}» نهائياً.</p>
        <p className="muted">
          المستخدمون المعيّنون على هذا الدور حالياً: {deleteRoleDialog?.row.userCount ?? 0}. سيُحذف الدور
          وصلاحياته الخاصة فقط — لن يتأثر أي مستخدم أو دور آخر.
        </p>
        <p className="muted">هذا الإجراء نهائي ولا يمكن التراجع عنه.</p>
        <Field label={`للتأكيد، اكتب: ${deleteRoleDialog?.row.name ?? ''}`} required>
          <Input value={deleteRoleDialog?.confirmation ?? ''} onChange={(e) => setDeleteRoleDialog(deleteRoleDialog ? { ...deleteRoleDialog, confirmation: e.target.value, error: undefined } : undefined)} />
        </Field>
      </Modal>
    </>
  )
}
