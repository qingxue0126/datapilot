import type { Express, Request, Response } from "express";
import { AccountStore, AuthError } from "./account-store.js";

export const AUTH_COOKIE = "datapilot_session";

export function installAuthRoutes(app: Express, accounts: AccountStore) {
  app.post("/api/auth/register", async (request, response) => {
    try {
      const result = await accounts.register(request.body?.identifier, request.body?.password, request.body?.confirmPassword);
      setSessionCookie(response, result.token);
      response.status(201).json({ user: result.user });
    } catch (error) { authFailure(response, error); }
  });

  app.post("/api/auth/login", async (request, response) => {
    try {
      const result = await accounts.login(request.body?.identifier, request.body?.password);
      setSessionCookie(response, result.token);
      response.json({ user: result.user });
    } catch (error) { authFailure(response, error); }
  });

  app.post("/api/auth/logout", (request, response) => {
    accounts.logout(sessionToken(request));
    clearSessionCookie(response);
    response.status(204).end();
  });

  app.get("/api/auth/me", (request, response) => {
    try { response.json(accounts.authenticate(sessionToken(request))); }
    catch (error) { authFailure(response, error); }
  });

  app.get("/api/auth/account-center", (request, response) => {
    try { response.json(accounts.accountCenter(sessionToken(request))); }
    catch (error) { authFailure(response, error); }
  });

  app.patch("/api/auth/profile", (request, response) => {
    try { response.json({ user: accounts.updateProfile(sessionToken(request), request.body?.displayName) }); }
    catch (error) { authFailure(response, error); }
  });

  app.post("/api/auth/password", async (request, response) => {
    try {
      await accounts.changePassword(sessionToken(request), request.body?.currentPassword, request.body?.newPassword, request.body?.confirmPassword);
      response.status(204).end();
    } catch (error) { authFailure(response, error); }
  });

  app.post("/api/auth/teams/switch", (request, response) => {
    try { response.json(accounts.switchTeam(sessionToken(request), request.body?.tenantId)); }
    catch (error) { authFailure(response, error); }
  });

  app.post("/api/auth/admin/teams", (request, response) => {
    try { response.status(201).json({ team: accounts.createTeam(sessionToken(request), request.body?.name) }); }
    catch (error) { authFailure(response, error); }
  });

  app.post("/api/auth/admin/invitations", (request, response) => {
    try { response.status(201).json(accounts.inviteMember(sessionToken(request), request.body || {})); }
    catch (error) { authFailure(response, error); }
  });

  app.patch("/api/auth/admin/members/:userId", (request, response) => {
    try { response.json({ membership: accounts.updateMemberRole(sessionToken(request), request.params.userId, request.body || {}) }); }
    catch (error) { authFailure(response, error); }
  });

  app.delete("/api/auth/account", (request, response) => {
    try {
      if (request.body?.confirmation !== "DELETE") throw new AuthError("请输入 DELETE 确认注销账户", 400);
      accounts.deleteAccount(sessionToken(request));
      clearSessionCookie(response);
      response.status(204).end();
    } catch (error) { authFailure(response, error); }
  });
}

export function sessionToken(request: Request) {
  const cookies = Object.fromEntries((request.header("cookie") || "").split(";").map((part) => {
    const index = part.indexOf("=");
    return index < 0 ? [part.trim(), ""] : [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1))];
  }));
  return cookies[AUTH_COOKIE];
}

function setSessionCookie(response: Response, token: string) {
  response.cookie(AUTH_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 7 * 24 * 60 * 60 * 1000 });
}
function clearSessionCookie(response: Response) {
  response.clearCookie(AUTH_COOKIE, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/" });
}
function authFailure(response: Response, error: unknown) {
  const status = error instanceof AuthError ? error.status : 500;
  const message = error instanceof Error ? error.message : "认证服务异常";
  response.status(status).json({ error: status === 500 ? "认证服务异常" : message });
}
