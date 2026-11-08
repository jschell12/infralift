import { Router } from "express";
import { z } from "zod";
import { handle, parseBody } from "../lib/errors.js";
import { isSafePath } from "../lib/import/check.js";
import { adoptFromAssessment, importModule, readImportCheck, scanRepository } from "../services/imports.js";

// HTTP for importing existing Terraform (services/imports.ts holds the rules).
//
//   POST /tf/imports/scan             list a repository's root modules
//   POST /tf/imports                  import one root module
//   POST /tf/imports/from-assessment  adopt a cloud account's resources as they run
//   GET  /tf/imports/:projectId/check what the read-only check said

export const importsRouter = Router();

const repoField = z.string().regex(/^[\w.-]+\/[\w.-]+$/, "a GitHub repository is owner/name");

const scanSchema = z.object({
  repo: repoField,
  ref: z.string().min(1).optional(),
  connectionId: z.string().min(1).optional(),
});

const nameField = z
  .string()
  .regex(/^[a-z][a-z0-9-]{2,31}$/, "3-32 characters: lowercase letters, digits and dashes, starting with a letter");

const importSchema = scanSchema.extend({
  name: nameField,
  path: z.string().max(512).default(""),
  backendConfigFile: z.string().min(1).optional(),
});

const adoptSchema = scanSchema.extend({
  assessmentId: z.string().min(1),
  name: nameField,
  path: z.string().max(200).refine(isSafePath, "letters, digits, dot, dash, underscore and slash"),
  backend: z.object({
    kind: z.enum(["s3", "r2"]),
    bucket: z.string(),
    key: z.string(),
    region: z.string().optional(),
    accountId: z.string().optional(),
  }),
});

importsRouter.post(
  "/scan",
  handle(async (req, res) => {
    res.json(await scanRepository(req.user!.orgId, parseBody(scanSchema, req.body)));
  })
);

importsRouter.post(
  "/",
  handle(async (req, res) => {
    res.status(202).json(await importModule(req.user!.orgId, parseBody(importSchema, req.body)));
  })
);

importsRouter.get(
  "/:projectId/check",
  handle(async (req, res) => {
    res.json(await readImportCheck(req.user!.orgId, req.params.projectId));
  })
);

importsRouter.post(
  "/from-assessment",
  handle(async (req, res) => {
    res.status(202).json(await adoptFromAssessment(req.user!.orgId, parseBody(adoptSchema, req.body)));
  })
);
