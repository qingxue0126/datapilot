import type { Express } from "express";
import { AccountStore, AuthError } from "./account-store.js";

import { authFailure, clearSessionCookie, sessionToken, setSessionCookie } from "./session-cookie.js";

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


  app.patch("/api/auth/profile", (request, response) => {
    try { response.json({ user: accounts.updateProfile(sessionToken(request), request.body || {}) }); }
    catch (error) { authFailure(response, error); }
  });

  app.post("/api/auth/password", async (request, response) => {
    try {
      await accounts.changePassword(sessionToken(request), request.body?.currentPassword, request.body?.newPassword, request.body?.confirmPassword);
      response.status(204).end();
    } catch (error) { authFailure(response, error); }
  });


  app.get("/api/auth/api-keys", (request, response) => {
    try { response.json({ items: accounts.listApiKeys(sessionToken(request)) }); }
    catch (error) { authFailure(response, error); }
  });

  app.post("/api/auth/api-keys", (request, response) => {
    try { response.status(201).json(accounts.createApiKey(sessionToken(request), request.body?.name)); }
    catch (error) { authFailure(response, error); }
  });

  app.patch("/api/auth/api-keys/:id", (request, response) => {
    try {
      if (typeof request.body?.enabled !== "boolean") throw new AuthError("enabled 必须是布尔值", 400);
      response.json({ apiKey: accounts.setApiKeyEnabled(sessionToken(request), request.params.id, request.body.enabled) });
    } catch (error) { authFailure(response, error); }
  });

  app.delete("/api/auth/api-keys/:id", (request, response) => {
    try { accounts.revokeApiKey(sessionToken(request), request.params.id); response.status(204).end(); }
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

