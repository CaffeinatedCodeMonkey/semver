import { ExecutorContext, logger } from '@nrwl/devkit';
import { concat, defer, of } from 'rxjs';
import { catchError, mapTo, switchMap } from 'rxjs/operators';

import { tryPushToGitRemote } from './utils/git';
import { resolveTagTemplate } from './utils/tag-template';
import { tryBump } from './utils/try-bump';
import { getProjectRoot } from './utils/workspace';
import { versionProject, versionWorkspace } from './version';

import type { CommonVersionOptions } from './version';
import type { VersionBuilderSchema } from './schema';
import { getProjectDependencies } from './utils/get-project-dependencies';

export default async function version(
  {
    push,
    remote,
    dryRun,
    useDeps,
    baseBranch,
    noVerify,
    syncVersions,
    skipRootChangelog,
    skipProjectChangelog,
    version,
    preid,
    changelogHeader,
    versionTagPrefix,
  }: VersionBuilderSchema,
  context: ExecutorContext
): Promise<{ success: boolean }> {
  const workspaceRoot = context.root;
  const preset = 'angular';
  const tagPrefix = versionTagPrefix ? resolveTagTemplate(versionTagPrefix,
      { target: context.projectName, projectName: context.projectName })
    : (syncVersions ? 'v' : `${context.projectName}-`);

  const projectRoot = getProjectRoot(context);

  let dependencyRoots = [];
  if (useDeps && !version) {
    // Include any depended-upon libraries in determining the version bump.
    try {
      const dependencyLibs = await getProjectDependencies(context.projectName);
      dependencyRoots = dependencyLibs
        .map(name => context.workspace.projects[name].root);
    } catch (e) {
      logger.error('Failed to determine dependencies.');
      return Promise.resolve(e);
    }
  }

  const newVersion$ = tryBump({
    preset,
    projectRoot,
    dependencyRoots,
    tagPrefix,
    releaseType: version,
    preid,
  });

  const action$ = newVersion$.pipe(
    switchMap((newVersion) => {
      if (newVersion == null) {
        logger.info('⏹ Nothing changed since last release.');
        return of(undefined);
      }

      const options: CommonVersionOptions = {
        dryRun,
        useDeps,
        newVersion,
        noVerify,
        preset,
        projectRoot,
        tagPrefix,
        changelogHeader,
      };

      const runStandardVersion$ = defer(() =>
        syncVersions
          ? versionWorkspace({
              ...options,
              skipRootChangelog,
              skipProjectChangelog,
              workspaceRoot,
            })
          : versionProject(options)
      );
      const pushToGitRemote$ = defer(() =>
        tryPushToGitRemote({
          branch: baseBranch,
          noVerify,
          remote,
        })
      );

      return concat(
        runStandardVersion$,
        ...(push && dryRun === false ? [pushToGitRemote$] : [])
      );
    })
  );

  return action$.pipe(
    mapTo({ success: true }),
    catchError((error) => {
      logger.error(error.stack ?? error.toString());
      return of({ success: false });
    })
  ).toPromise();
}
