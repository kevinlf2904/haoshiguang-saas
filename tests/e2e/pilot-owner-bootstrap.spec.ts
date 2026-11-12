import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const tenantId = process.env.PILOT_OWNER_BOOTSTRAP_TENANT_ID!;
const bootstrapSecret = process.env.PILOT_OWNER_BOOTSTRAP_SECRET!;
const admin = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

test("Pilot bootstrap HTTP/Auth integration is idempotent and binds one owner to the configured tenant", async ({ request }) => {
  expect(tenantId).toMatch(/^[0-9a-f-]{36}$/i);
  expect(bootstrapSecret.length).toBeGreaterThanOrEqual(32);

  const email = `pilot-bootstrap-${Date.now()}@haoshiguang.test`;

  const denied = await request.post("/api/merchant/bootstrap", {
    headers: { "x-pilot-bootstrap-secret": "incorrect-bootstrap-secret" },
    data: { email },
  });
  expect(denied.status()).toBe(403);

  const invalid = await request.post("/api/merchant/bootstrap", {
    headers: { "x-pilot-bootstrap-secret": bootstrapSecret },
    data: { email: "not-an-email" },
  });
  expect(invalid.status()).toBe(400);

  const first = await request.post("/api/merchant/bootstrap", {
    headers: { "x-pilot-bootstrap-secret": bootstrapSecret },
    data: { email },
  });
  const firstBody = await first.json();
  expect(first.status()).toBe(202);
  expect(firstBody.ok).toBe(true);

  const { data: usersAfterFirst, error: listFirstError } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  expect(listFirstError).toBeNull();
  const firstUser = usersAfterFirst.users.find(user => user.email?.toLowerCase() === email);
  expect(firstUser).toBeTruthy();
  expect(firstUser!.app_metadata?.pilot_owner_bootstrap_reservation).toBeTruthy();

  // The user may edit user_metadata after accepting the invitation. Recovery
  // must rely on the server-controlled app_metadata marker, not mutable profile data.
  const { error: mutateUserMetadataError } = await admin.auth.admin.updateUserById(firstUser!.id, {
    user_metadata: { pilot_owner_bootstrap_reservation: "user-controlled-tampered-value" },
  });
  expect(mutateUserMetadataError).toBeNull();

  const { data: firstMembership, error: firstMembershipError } = await admin
    .from("memberships").select("tenant_id,user_id,role")
    .eq("tenant_id", tenantId).eq("user_id", firstUser!.id).single();
  expect(firstMembershipError).toBeNull();
  expect(firstMembership).toMatchObject({ tenant_id: tenantId, user_id: firstUser!.id, role: "owner" });

  // A retry after successful completion must reuse the same Auth user and
  // completed reservation; it must not create another account or membership.
  const retry = await request.post("/api/merchant/bootstrap", {
    headers: { "x-pilot-bootstrap-secret": bootstrapSecret },
    data: { email: email.toUpperCase() },
  });
  expect(retry.status()).toBe(202);

  const { data: usersAfterRetry, error: listRetryError } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  expect(listRetryError).toBeNull();
  expect(usersAfterRetry.users.filter(user => user.email?.toLowerCase() === email)).toHaveLength(1);
  const { data: membershipsAfterRetry, error: membershipRetryError } = await admin
    .from("memberships").select("id,tenant_id,user_id,role")
    .eq("tenant_id", tenantId).eq("user_id", firstUser!.id);
  expect(membershipRetryError).toBeNull();
  expect(membershipsAfterRetry ?? []).toHaveLength(1);
  expect(membershipsAfterRetry?.[0]?.role).toBe("owner");

  // A different email cannot take over a completed one-time bootstrap.
  const replay = await request.post("/api/merchant/bootstrap", {
    headers: { "x-pilot-bootstrap-secret": bootstrapSecret },
    data: { email: `other-${Date.now()}@haoshiguang.test` },
  });
  expect(replay.status()).toBe(409);
});
