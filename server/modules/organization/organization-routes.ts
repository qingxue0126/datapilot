import type { Express } from "express";
import { type AccountStore, authFailure, sessionToken } from "../auth/index.js";

/** One account aggregate preserves atomic account/team membership updates and the on-disk format. */
export type OrganizationAccounts = Pick<AccountStore,
  "accountCenter" | "switchTeam" | "createTeam" | "updateTeam" | "deleteTeam" |
  "inviteMember" | "createManagedMember" | "respondToInvitation" | "updateMemberRole" |
  "updateManagedMember" | "removeManagedMember" | "resetManagedMemberPassword"
>;

export function installOrganizationRoutes(app: Express, accounts: OrganizationAccounts) {
  app.get("/api/auth/account-center", (request, response) => {
    try { response.json(accounts.accountCenter(sessionToken(request), request.query.scope === "platform" ? "platform" : "tenant")); }
    catch (error) { authFailure(response, error); }
  });

  app.post("/api/auth/teams/switch", (request, response) => {
    try { response.json(accounts.switchTeam(sessionToken(request), request.body?.tenantId)); }
    catch (error) { authFailure(response, error); }
  });

  app.post("/api/auth/admin/teams", (request, response) => {
    try { response.status(201).json({ team: accounts.createTeam(sessionToken(request), request.body?.name) }); }
    catch (error) { authFailure(response, error); }
  });

  app.patch("/api/auth/admin/teams/:id", (request, response) => {
    try { response.json({ team: accounts.updateTeam(sessionToken(request), request.params.id, request.body || {}) }); }
    catch (error) { authFailure(response, error); }
  });

  app.delete("/api/auth/admin/teams/:id", (request, response) => {
    try { response.json(accounts.deleteTeam(sessionToken(request), request.params.id)); }
    catch (error) { authFailure(response, error); }
  });

  app.post("/api/auth/admin/invitations", (request, response) => {
    try { response.status(201).json(accounts.inviteMember(sessionToken(request), request.body || {})); }
    catch (error) { authFailure(response, error); }
  });

  app.post("/api/auth/admin/members", async (request, response) => {
    try { response.status(201).json(await accounts.createManagedMember(sessionToken(request), request.body || {})); }
    catch (error) { authFailure(response, error); }
  });

  app.post("/api/auth/invitations/:id/accept", (request, response) => {
    try { response.json(accounts.respondToInvitation(sessionToken(request), request.params.id, true)); }
    catch (error) { authFailure(response, error); }
  });

  app.post("/api/auth/invitations/:id/reject", (request, response) => {
    try { response.json(accounts.respondToInvitation(sessionToken(request), request.params.id, false)); }
    catch (error) { authFailure(response, error); }
  });

  app.patch("/api/auth/admin/members/:userId", (request, response) => {
    try { response.json({ membership: accounts.updateMemberRole(sessionToken(request), request.params.userId, request.body || {}) }); }
    catch (error) { authFailure(response, error); }
  });

  app.patch("/api/auth/admin/members/:userId/profile", (request, response) => {
    try { response.json({ membership: accounts.updateManagedMember(sessionToken(request), request.params.userId, request.body || {}) }); }
    catch (error) { authFailure(response, error); }
  });

  app.delete("/api/auth/admin/members/:userId", (request, response) => {
    try { response.json(accounts.removeManagedMember(sessionToken(request), request.params.userId, request.body?.tenantId)); }
    catch (error) { authFailure(response, error); }
  });

  app.post("/api/auth/admin/members/:userId/reset-password", async (request, response) => {
    try { response.json(await accounts.resetManagedMemberPassword(sessionToken(request), request.params.userId, request.body || {})); }
    catch (error) { authFailure(response, error); }
  });
}
