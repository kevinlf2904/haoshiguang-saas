import { createHash } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const ownerEmail = "e2e-owner@haoshiguang.test";
const ownerPassword = "LocalOnly-E2E-Password-2026!";
const memberInviteMarker = "haoshiguang_member_invite_recovery";

async function login(page: Page, email: string, password: string) {
  await page.goto("/merchant/login");
  await page.getByLabel("電子郵件").fill(email);
  await page.getByLabel("密碼").fill(password);
  await page.getByRole("button", { name: "登入管理後台" }).click();
  await expect(page).toHaveURL(/\/merchant\/orders$/);
}

async function memberApi(page: Page, method: "GET" | "POST" | "DELETE", path: string, body?: unknown) {
  return page.evaluate(async ({ method, path, body }) => {
    const response = await fetch(path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: "no-store",
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  }, { method, path, body });
}

test("會員 API/Auth 整合：權限邊界、邀請重試恢復、租戶隔離與原子移除", async ({ page, request, browser }) => {
  const { data: tenant, error: tenantError } = await admin.from("tenants")
    .select("id").eq("slug", "laozhang").single();
  expect(tenantError).toBeNull();
  expect(tenant).toBeTruthy();
  const tenantId = tenant!.id;

  const suffix = Date.now().toString();
  const managerEmail = `e2e-manager-${suffix}@haoshiguang.test`;
  const outsiderEmail = `e2e-outsider-${suffix}@haoshiguang.test`;
  const recoveryEmail = `e2e-recovery-${suffix}@haoshiguang.test`;
  const ownerManagerEmail = `e2e-owner-manager-${suffix}@haoshiguang.test`;
  const staffEmail = `e2e-staff-${suffix}@haoshiguang.test`;
  const password = "LocalOnly-Member-Password-2026!";
  const createdUserIds: string[] = [];
  let otherTenantId: string | null = null;

  try {
    // Unauthenticated API calls must not reveal tenant membership data.
    const anonymous = await request.get(`/api/merchant/members?tenantId=${tenantId}`);
    expect(anonymous.status()).toBe(401);

    const { data: managerCreated, error: managerCreateError } = await admin.auth.admin.createUser({
      email: managerEmail, password, email_confirm: true,
    });
    expect(managerCreateError).toBeNull();
    expect(managerCreated.user).toBeTruthy();
    createdUserIds.push(managerCreated.user!.id);
    const { error: managerMembershipError } = await admin.from("memberships").insert({
      tenant_id: tenantId, user_id: managerCreated.user!.id, role: "manager",
    });
    expect(managerMembershipError).toBeNull();

    const { data: outsiderCreated, error: outsiderCreateError } = await admin.auth.admin.createUser({
      email: outsiderEmail, password, email_confirm: true,
    });
    expect(outsiderCreateError).toBeNull();
    expect(outsiderCreated.user).toBeTruthy();
    createdUserIds.push(outsiderCreated.user!.id);

    const { data: otherTenant, error: otherTenantError } = await admin.from("tenants").insert({
      name: "Member isolation test tenant",
      slug: `member-isolation-${suffix}`,
      currency: "TWD",
    }).select("id").single();
    expect(otherTenantError).toBeNull();
    expect(otherTenant).toBeTruthy();
    otherTenantId = otherTenant!.id;
    const { error: otherTenantMembershipError } = await admin.from("memberships").insert({
      tenant_id: otherTenantId, user_id: outsiderCreated.user!.id, role: "staff",
    });
    expect(otherTenantMembershipError).toBeNull();

    await login(page, ownerEmail, ownerPassword);

    const invalidRole = await memberApi(page, "POST", "/api/merchant/members", {
      tenantId, email: `invalid-${suffix}@haoshiguang.test`, role: "owner",
    });
    expect(invalidRole.status).toBe(400);

    // Simulate the recoverable partial-failure state: Auth invitation exists,
    // but the DB membership/invite transaction has not yet been confirmed.
    // A retry must adopt this exact tagged invite rather than create/delete users.
    const marker = createHash("sha256")
      .update(`${tenantId}:member-invite:staff:${recoveryEmail}`)
      .digest("hex");
    const { data: pendingInvite, error: pendingInviteError } = await admin.auth.admin.inviteUserByEmail(
      recoveryEmail, { data: { [memberInviteMarker]: marker } },
    );
    expect(pendingInviteError).toBeNull();
    expect(pendingInvite.user).toBeTruthy();
    createdUserIds.push(pendingInvite.user!.id);

    const recovered = await memberApi(page, "POST", "/api/merchant/members", {
      tenantId, email: recoveryEmail.toUpperCase(), role: "staff",
    });
    expect(recovered.status).toBe(202);

    const { data: recoveredUsers, error: recoveredUsersError } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    expect(recoveredUsersError).toBeNull();
    expect(recoveredUsers.users.filter(user => user.email?.toLowerCase() === recoveryEmail)).toHaveLength(1);
    const recoveredUser = recoveredUsers.users.find(user => user.id === pendingInvite.user!.id);
    expect(recoveredUser?.app_metadata?.[memberInviteMarker]).toBe(marker);

    const { data: recoveredMembership, error: recoveredMembershipError } = await admin.from("memberships")
      .select("user_id,role").eq("tenant_id", tenantId).eq("user_id", pendingInvite.user!.id).single();
    expect(recoveredMembershipError).toBeNull();
    expect(recoveredMembership).toMatchObject({ user_id: pendingInvite.user!.id, role: "staff" });

    const { data: recoveredInviteRow, error: recoveredInviteRowError } = await admin.from("tenant_membership_invites")
      .select("user_id,role").eq("tenant_id", tenantId).eq("normalized_email", recoveryEmail).single();
    expect(recoveredInviteRowError).toBeNull();
    expect(recoveredInviteRow).toMatchObject({ user_id: pendingInvite.user!.id, role: "staff" });

    // Retry is idempotent: same Auth user, membership and invite record.
    const retry = await memberApi(page, "POST", "/api/merchant/members", {
      tenantId, email: recoveryEmail, role: "staff",
    });
    expect(retry.status).toBe(202);
    const { data: retryMemberships } = await admin.from("memberships").select("id")
      .eq("tenant_id", tenantId).eq("user_id", pendingInvite.user!.id);
    expect(retryMemberships).toHaveLength(1);
    const { data: retryInvites } = await admin.from("tenant_membership_invites").select("id")
      .eq("tenant_id", tenantId).eq("normalized_email", recoveryEmail);
    expect(retryInvites).toHaveLength(1);

    const conflictingRole = await memberApi(page, "POST", "/api/merchant/members", {
      tenantId, email: recoveryEmail, role: "manager",
    });
    expect(conflictingRole.status).toBe(409);

    const ownerManagerInvite = await memberApi(page, "POST", "/api/merchant/members", {
      tenantId, email: ownerManagerEmail, role: "manager",
    });
    expect(ownerManagerInvite.status).toBe(202);
    const { data: ownerManagerInviteRow, error: ownerManagerInviteError } = await admin.from("tenant_membership_invites")
      .select("user_id,role").eq("tenant_id", tenantId).eq("normalized_email", ownerManagerEmail).single();
    expect(ownerManagerInviteError).toBeNull();
    expect(ownerManagerInviteRow?.role).toBe("manager");
    if (ownerManagerInviteRow?.user_id) createdUserIds.push(ownerManagerInviteRow.user_id);
    const ownerManagerRetry = await memberApi(page, "POST", "/api/merchant/members", {
      tenantId, email: ownerManagerEmail.toUpperCase(), role: "manager",
    });
    expect(ownerManagerRetry.status).toBe(202);
    const { data: ownerManagerMemberships } = await admin.from("memberships").select("id")
      .eq("tenant_id", tenantId).eq("user_id", ownerManagerInviteRow!.user_id);
    expect(ownerManagerMemberships).toHaveLength(1);

    const ownerList = await memberApi(page, "GET", `/api/merchant/members?tenantId=${tenantId}`);
    expect(ownerList.status).toBe(200);
    expect(ownerList.body.members.some((member: { email: string }) => member.email === recoveryEmail)).toBe(true);

    // Manager role is limited to staff invites/removals.
    const managerContext = await browser.newContext();
    const managerPage = await managerContext.newPage();
    try {
      await login(managerPage, managerEmail, password);
      const managerEscalation = await memberApi(managerPage, "POST", "/api/merchant/members", {
        tenantId, email: `manager-escalation-${suffix}@haoshiguang.test`, role: "manager",
      });
      expect(managerEscalation.status).toBe(403);

      const managerInvite = await memberApi(managerPage, "POST", "/api/merchant/members", {
        tenantId, email: staffEmail, role: "staff",
      });
      expect(managerInvite.status).toBe(202);

      const { data: staffInviteRow, error: staffInviteError } = await admin.from("tenant_membership_invites")
        .select("user_id,role").eq("tenant_id", tenantId).eq("normalized_email", staffEmail).single();
      expect(staffInviteError).toBeNull();
      expect(staffInviteRow?.role).toBe("staff");
      if (staffInviteRow?.user_id) createdUserIds.push(staffInviteRow.user_id);

      const { data: managerMembership } = await admin.from("memberships").select("id")
        .eq("tenant_id", tenantId).eq("user_id", managerCreated.user!.id).single();
      const managerRemoveManager = await memberApi(managerPage, "DELETE", "/api/merchant/members", {
        tenantId, membershipId: managerMembership!.id,
      });
      expect(managerRemoveManager.status).toBe(403);

      const { data: ownerMembership } = await admin.from("memberships").select("id")
        .eq("tenant_id", tenantId).eq("user_id", (await admin.auth.admin.listUsers({ page: 1, perPage: 1000 }))
          .data.users.find(user => user.email === ownerEmail)!.id).single();
      const managerRemoveOwner = await memberApi(managerPage, "DELETE", "/api/merchant/members", {
        tenantId, membershipId: ownerMembership!.id,
      });
      expect(managerRemoveOwner.status).toBe(409);

      const { data: staffMembership } = await admin.from("memberships").select("id")
        .eq("tenant_id", tenantId).eq("user_id", staffInviteRow!.user_id).single();
      const managerRemoveStaff = await memberApi(managerPage, "DELETE", "/api/merchant/members", {
        tenantId, membershipId: staffMembership!.id,
      });
      expect(managerRemoveStaff.status).toBe(200);
      const { data: staffAfterRemoval } = await admin.from("memberships").select("id")
        .eq("tenant_id", tenantId).eq("user_id", staffInviteRow!.user_id);
      expect(staffAfterRemoval).toHaveLength(0);
      const { data: inviteAfterRemoval } = await admin.from("tenant_membership_invites").select("id")
        .eq("tenant_id", tenantId).eq("user_id", staffInviteRow!.user_id);
      expect(inviteAfterRemoval).toHaveLength(0);
    } finally {
      await managerContext.close();
    }

    // A valid account without membership in this tenant is not authorized.
    const outsiderContext = await browser.newContext();
    const outsiderPage = await outsiderContext.newPage();
    try {
      await login(outsiderPage, outsiderEmail, password);
      const outsiderOwnTenantRead = await memberApi(outsiderPage, "GET", `/api/merchant/members?tenantId=${otherTenantId}`);
      expect(outsiderOwnTenantRead.status).toBe(403);
      const outsiderCrossTenantRead = await memberApi(outsiderPage, "GET", `/api/merchant/members?tenantId=${tenantId}`);
      expect(outsiderCrossTenantRead.status).toBe(403);
      const outsiderInvite = await memberApi(outsiderPage, "POST", "/api/merchant/members", {
        tenantId, email: `unauthorized-${suffix}@haoshiguang.test`, role: "staff",
      });
      expect(outsiderInvite.status).toBe(403);
    } finally {
      await outsiderContext.close();
    }

    // Owner can remove the manager fixture, but cannot remove itself.
    const ownerRemoveManager = await memberApi(page, "DELETE", "/api/merchant/members", {
      tenantId,
      membershipId: (await admin.from("memberships").select("id")
        .eq("tenant_id", tenantId).eq("user_id", managerCreated.user!.id).single()).data!.id,
    });
    expect(ownerRemoveManager.status).toBe(200);
  } finally {
    if (otherTenantId) await admin.from("tenants").delete().eq("id", otherTenantId);
    for (const userId of [...new Set(createdUserIds)]) {
      await admin.auth.admin.deleteUser(userId);
    }
  }
});
