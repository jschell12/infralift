import type { Project } from "@infralift/shared";
import { prisma } from "../lib/db.js";
import { PROJECT_ROW_INCLUDE, ProjectShapeError, toProjectView } from "../lib/projects/view.js";

/** Most projects one list returns. A ceiling against an unbounded read, far
 *  above what an org has today, not a page size. */
export const PROJECT_LIST_CAP = 200;

/** The org's projects, one type per kind. A row that does not fit its kind is
 *  logged by id and left out, so one bad row cannot take the list down. */
export async function listProjects(orgId: string): Promise<Project[]> {
  const rows = await prisma.tfProject.findMany({
    where: { orgId },
    include: PROJECT_ROW_INCLUDE,
    orderBy: { name: "asc" },
    take: PROJECT_LIST_CAP,
  });
  const projects: Project[] = [];
  for (const row of rows) {
    try {
      projects.push(toProjectView(row));
    } catch (err) {
      if (!(err instanceof ProjectShapeError)) throw err;
      console.error(err.message);
    }
  }
  return projects;
}
