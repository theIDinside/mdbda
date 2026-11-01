import * as fs from 'fs';
import * as path from 'path';

const mdbdaRepositoryDirectory = path.resolve(__dirname, '../..');

/**
 * `localConfigPath` shall point to a file inside this repo that configures where the mdb repo is located on your machine.
 * If that file doesn't exist, we fall back to environment variable MDB_REPO_DIR for the repo root, but we'll also need a
 * secondary MDB_BIN_DIR that points to the binary dir where the user configured to put built binaries in.
 *
 * example of 'mdbda.test.config.json'
 * {
 *   "mdbRepoDir": "../dbm",
 *   "mdbBinaryDir": "../dbm/obj/debug/bin",
 *   "logDirectory": <optional>
 * }
 */
const localConfigPath = path.join(mdbdaRepositoryDirectory, 'mdbda.test.config.json');

function canExecute(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export class TestConfig {
  private readonly mdbBinaryPath: string;
  constructor(readonly mdbRepoDir: string, readonly mdbBinaryDir: string, readonly logDirectory: string | null = null) {
    this.mdbBinaryPath = path.join(this.mdbBinaryDir, "mdb");
  }

  get mdbPath() {
    if(canExecute(this.mdbBinaryPath)) {
      return this.mdbBinaryPath;
    }
    throw new Error(`${this.mdbBinaryPath} could not be found or could not be executed.`);
  }

  testSubject(name: string): string {
    const f = path.join(this.mdbBinaryDir, name);
    if(canExecute(f)) {
      return f;
    }
    throw new Error(`could not find ${f}`);
  }

  file(name: string) : string {
    const f = path.join(this.mdbRepoDir, name);
    if(fs.existsSync(f)) {
      return f;
    }
    throw new Error(`could not find file ${f}`);
  }

  static readTestConfig(): TestConfig {
    if (!fs.existsSync(localConfigPath)) {
	  throw new Error(`Could not read test configuration file`);
    }
    const config: unknown = JSON.parse(fs.readFileSync(localConfigPath, 'utf8'));

    const stringFields = ["mdbRepoDir", "mdbBinaryDir"] as const;

    if (!isRecord(config)) {
      throw new Error(`config must be a record`);
    }

    if (typeof config.mdbRepoDir !== 'string') {
      throw new Error(`mdbRepoDir must be a string`);
    }

    if (typeof config.mdbBinaryDir !== 'string') {
      throw new Error(`mdbBinaryDir must be a string`);
    }


    let logDirectory: string | null = null;
    if('logDirectory' in config && typeof config.logDirectory === 'string') {
	  logDirectory = config.logDirectory;
    }

    return new TestConfig(path.resolve(mdbdaRepositoryDirectory, config.mdbRepoDir), path.resolve(mdbdaRepositoryDirectory, config.mdbBinaryDir), logDirectory);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

