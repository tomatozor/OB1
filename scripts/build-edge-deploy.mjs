#!/usr/bin/env node

import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const serverRoot = join(repositoryRoot, "server");
const localBuildRoot = join(repositoryRoot, ".edge-build");
const canonicalArtifacts = [
  { source: join(serverRoot, "index.ts"), destination: "index.ts" },
  { source: join(serverRoot, "deno.json"), destination: "deno.json" },
];

function usageError(message) {
  throw new Error(
    `${message}\nUsage: node scripts/build-edge-deploy.mjs --out <path>`,
  );
}

function parseArguments(arguments_) {
  if (
    arguments_.length !== 2 || arguments_[0] !== "--out" ||
    typeof arguments_[1] !== "string" || arguments_[1].length === 0 ||
    arguments_[1].startsWith("-")
  ) {
    usageError("Exactly one --out <path> argument is required.");
  }
  return resolve(arguments_[1]);
}

function containsPath(parent, candidate) {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent === "" ||
    (!pathFromParent.startsWith(`..${sep}`) && pathFromParent !== ".." &&
      !isAbsolute(pathFromParent));
}

function assertProtectedPaths(outputPath) {
  const filesystemRoot = parse(outputPath).root;
  if (
    outputPath === filesystemRoot || outputPath === repositoryRoot ||
    outputPath === serverRoot
  ) {
    throw new Error("Refusing unsafe Edge build output directory.");
  }
  if (containsPath(serverRoot, outputPath)) {
    throw new Error("Refusing to build inside the canonical server directory.");
  }
  if (
    canonicalArtifacts.some(({ source }) => containsPath(outputPath, source))
  ) {
    throw new Error(
      "Refusing an output directory that contains a canonical deploy input.",
    );
  }
  if (
    outputPath === localBuildRoot ||
    !containsPath(localBuildRoot, outputPath)
  ) {
    throw new Error(
      "Edge build output must be a child of the repository .edge-build directory.",
    );
  }
}

async function existingPathInfo(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function resolvedThroughExistingAncestor(outputPath) {
  let ancestor = outputPath;
  while (true) {
    const info = await existingPathInfo(ancestor);
    if (info !== null) {
      const resolvedAncestor = await realpath(ancestor);
      return resolve(resolvedAncestor, relative(ancestor, outputPath));
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) {
      throw new Error("Unable to resolve the Edge build output directory.");
    }
    ancestor = parent;
  }
}

async function assertDestinationShape(outputPath) {
  const info = await existingPathInfo(outputPath);
  if (info?.isSymbolicLink()) {
    throw new Error("Refusing a symlinked Edge build output directory.");
  }
  if (info !== null && !info.isDirectory()) {
    throw new Error("Edge build output exists and is not a directory.");
  }
}

async function assertSafeOutput(outputPath) {
  assertProtectedPaths(outputPath);
  await assertDestinationShape(outputPath);
  const resolvedOutput = await resolvedThroughExistingAncestor(outputPath);
  assertProtectedPaths(resolvedOutput);
}

async function build(outputPath) {
  await assertSafeOutput(outputPath);

  const outputParent = dirname(outputPath);
  await mkdir(outputParent, { recursive: true });
  await assertSafeOutput(outputPath);

  const stagingDirectory = await mkdtemp(
    join(outputParent, ".open-brain-edge-stage-"),
  );
  try {
    for (const artifact of canonicalArtifacts) {
      await copyFile(
        artifact.source,
        join(stagingDirectory, artifact.destination),
      );
    }

    await assertSafeOutput(outputPath);
    const currentDestination = await existingPathInfo(outputPath);
    if (currentDestination !== null) {
      await rm(outputPath, { recursive: true, force: false });
    }
    await rename(stagingDirectory, outputPath);
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
}

try {
  const outputPath = parseArguments(process.argv.slice(2));
  await build(outputPath);
  console.log(`Built deterministic Edge artifact at ${outputPath}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
