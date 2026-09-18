"use strict";
var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};

// src/shutdown-sync.js
var require_shutdown_sync = __commonJS({
  "src/shutdown-sync.js"(exports2, module2) {
    "use strict";
    async function pushOnExit(git, timeoutMs = 15e3) {
      const deadline = Date.now() + timeoutMs;
      const run = (args) => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("\uC885\uB8CC \uC2DC Push \uC2DC\uAC04\uC774 \uCD08\uACFC\uB418\uC5C8\uC2B5\uB2C8\uB2E4");
        return git(args, {
          timeout: remaining,
          windowsHide: true,
          env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: "0",
            GCM_INTERACTIVE: "never",
            GIT_SSH_COMMAND: (process.env.GIT_SSH_COMMAND || "ssh") + " -oBatchMode=yes -oConnectTimeout=5"
          }
        });
      };
      if (!(await run(["remote"])).trim()) return false;
      const head = await run(["rev-parse", "--verify", "--quiet", "HEAD"]).catch(() => "");
      if (!head.trim()) return false;
      const upstream = (await run(["rev-parse", "--symbolic-full-name", "@{upstream}"]).catch(() => "")).trim();
      const count = Number((await run(upstream ? ["rev-list", "--count", upstream + "..HEAD"] : ["rev-list", "--count", "HEAD", "--not", "--remotes"])).trim());
      if (!count) return false;
      try {
        await run(["push"]);
      } catch (error) {
        if (!/no upstream|has no upstream|set-upstream/i.test(error.message)) throw error;
        const branch = (await run(["symbolic-ref", "--short", "HEAD"])).trim();
        await run(["push", "-u", "origin", branch]);
      }
      return true;
    }
    module2.exports = { pushOnExit };
  }
});

// src/git-service.js
var require_git_service = __commonJS({
  "src/git-service.js"(exports2, module2) {
    "use strict";
    var { execFile, execFileSync } = require("node:child_process");
    var fs = require("node:fs/promises");
    var syncFs = require("node:fs");
    var path = require("node:path");
    var { pushOnExit } = require_shutdown_sync();
    function parseStatus(output) {
      const records = output.split("\0"), files = [];
      for (let i = 0; i < records.length; i++) {
        const record = records[i];
        if (!record) continue;
        const index = record[0], work = record[1];
        const originalPath = /[RC]/.test(index + work) ? records[++i] : null;
        files.push({
          path: record.slice(3),
          originalPath,
          index,
          work,
          staged: index !== " " && index !== "?",
          unstaged: work !== " " || index === "?"
        });
      }
      return files;
    }
    function parseStats(output) {
      const records = output.split("\0"), stats = [];
      for (let i = 0; i < records.length; i++) {
        const match = /^(\S+)\t(\S+)\t(.*)$/s.exec(records[i]);
        if (!match) continue;
        let name = match[3];
        if (!name) {
          name = records[i + 2];
          i += 2;
        }
        if (name) stats.push({ path: name, lines: (Number(match[1]) || 0) + (Number(match[2]) || 0) });
      }
      return stats;
    }
    var GitService2 = class {
      constructor(root, { executable = "git", trash } = {}) {
        this.root = path.resolve(root);
        this.executable = executable;
        this.trash = trash;
      }
      run(args, options = {}) {
        return new Promise((resolve, reject) => {
          execFile(this.executable, ["-c", "core.quotepath=false", ...args], {
            cwd: this.root,
            windowsHide: true,
            timeout: 12e4,
            maxBuffer: 16 * 1024 * 1024,
            encoding: "utf8",
            env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" },
            ...options
          }, (error, stdout, stderr) => {
            if (error) {
              error.message = (stderr || error.message).trim();
              reject(error);
            } else resolve(stdout);
          });
        });
      }
      // beforeunload cannot wait for Promises. Only local, read-only commands run
      // here, with a shared deadline. Never stage, commit, or push synchronously.
      statusForExit(editors = []) {
        const deadline = Date.now() + 3e3;
        const run = (args) => {
          const remaining = deadline - Date.now();
          if (remaining <= 0) throw new Error("\uC885\uB8CC \uC804 Git \uC0C1\uD0DC \uD655\uC778 \uC2DC\uAC04\uC774 \uCD08\uACFC\uB418\uC5C8\uC2B5\uB2C8\uB2E4.");
          return execFileSync(this.executable, ["--no-optional-locks", "-c", "core.quotepath=false", ...args], {
            cwd: this.root,
            windowsHide: true,
            timeout: remaining,
            encoding: "utf8",
            maxBuffer: 16 * 1024 * 1024,
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" }
          });
        };
        let root;
        try {
          root = run(["rev-parse", "--show-toplevel"]).trim();
        } catch (error) {
          if (/not a git repository/i.test(String(error.stderr || error.message))) return { repo: false, files: [], unsaved: [] };
          throw error;
        }
        const actual = syncFs.realpathSync.native(root), expected = syncFs.realpathSync.native(this.root);
        const same = process.platform === "win32" ? actual.toLowerCase() === expected.toLowerCase() : actual === expected;
        if (!same) throw new Error("\uBCF4\uAD00\uD568 \uC0C1\uC704 \uD3F4\uB354\uC758 Git \uC800\uC7A5\uC18C\uB294 \uC885\uB8CC \uD655\uC778 \uB300\uC0C1\uC774 \uC544\uB2D9\uB2C8\uB2E4.");
        const files = parseStatus(run(["status", "--porcelain=v1", "-z", "--untracked-files=all"]));
        const unsaved = [];
        if (editors.length) {
          const paths = [...new Set(editors.map((editor) => this.validatePath(editor.path)))];
          const tracked = new Set(run(["--literal-pathspecs", "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", ...paths]).split("\0"));
          for (const editor of editors) {
            if (!tracked.has(editor.path)) continue;
            try {
              const disk = syncFs.readFileSync(path.join(this.root, editor.path), "utf8");
              if (disk.replace(/\r\n/g, "\n") !== editor.content.replace(/\r\n/g, "\n")) unsaved.push(editor.path);
            } catch {
              unsaved.push(editor.path);
            }
          }
        }
        return { repo: true, files, unsaved: [...new Set(unsaved)] };
      }
      async pushOnExit() {
        if (!await this.isRepo()) return false;
        return pushOnExit((args, options) => this.run(args, options));
      }
      async isRepo() {
        let root;
        try {
          root = (await this.run(["rev-parse", "--show-toplevel"])).trim();
        } catch (error) {
          if (/not a git repository/i.test(error.message)) return false;
          throw error;
        }
        const actual = await fs.realpath(root), expected = await fs.realpath(this.root);
        const same = process.platform === "win32" ? actual.toLowerCase() === expected.toLowerCase() : actual === expected;
        if (!same) throw new Error("\uBCF4\uAD00\uD568 \uC0C1\uC704 \uD3F4\uB354\uC758 \uC800\uC7A5\uC18C\uB294 \uC0AC\uC6A9\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4. \uBCF4\uAD00\uD568 \uB8E8\uD2B8\uC5D0 Git \uC800\uC7A5\uC18C\uB97C \uB9CC\uB4E4\uC5B4 \uC8FC\uC138\uC694.");
        return true;
      }
      async requireRepo() {
        if (!await this.isRepo()) throw new Error("Git \uC800\uC7A5\uC18C\uB97C \uBA3C\uC800 \uCD08\uAE30\uD654\uD574 \uC8FC\uC138\uC694.");
      }
      validatePath(name) {
        if (!name || name.includes("\0") || name.includes("\\") || path.isAbsolute(name) || name.split("/").some((p) => p === ".." || p.toLowerCase() === ".git")) {
          throw new Error("\uBCF4\uAD00\uD568 \uC548\uC758 \uD30C\uC77C \uACBD\uB85C\uB9CC \uC0AC\uC6A9\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4.");
        }
        return name;
      }
      async hasHead() {
        try {
          await this.run(["rev-parse", "--verify", "--quiet", "HEAD"]);
          return true;
        } catch (error) {
          if (error.code === 1) return false;
          throw error;
        }
      }
      async status() {
        if (!await this.isRepo()) return { repo: false, files: [], branch: "", ahead: 0 };
        const files = parseStatus(await this.run(["status", "--porcelain=v1", "-z", "--untracked-files=all"]));
        const head = await this.hasHead();
        const branch = head ? (await this.run(["rev-parse", "--abbrev-ref", "HEAD"])).trim() : "(\uCEE4\uBC0B \uC5C6\uC74C)";
        const remotes = (await this.run(["remote"])).trim();
        let ahead = 0;
        if (head && remotes) {
          let upstream = "";
          try {
            upstream = (await this.run(["rev-parse", "--symbolic-full-name", "@{upstream}"])).trim();
          } catch {
          }
          ahead = Number(await this.run(upstream ? ["rev-list", "--count", upstream + "..HEAD"] : ["rev-list", "--count", "HEAD", "--not", "--remotes"])) || 0;
        }
        return { repo: true, files, branch, ahead };
      }
      async init() {
        if (!await this.isRepo()) await this.run(["init"]);
      }
      async stage(name = ".") {
        await this.requireRepo();
        await this.run(["--literal-pathspecs", "add", "-A", "--", this.validatePath(name)]);
      }
      async unstage(name = ".") {
        await this.requireRepo();
        this.validatePath(name);
        const files = parseStatus(await this.run(["status", "--porcelain=v1", "-z", "--untracked-files=no"]));
        const renamed = files.find((file) => file.path === name && file.index === "R");
        const paths = renamed?.originalPath ? [name, renamed.originalPath] : [name];
        if (await this.hasHead()) await this.run(["--literal-pathspecs", "reset", "-q", "HEAD", "--", ...paths]);
        else await this.run(["--literal-pathspecs", "rm", "--cached", "-r", "-q", "--", ...paths]);
      }
      async diff(name, staged) {
        await this.requireRepo();
        this.validatePath(name);
        const output = await this.run(["--literal-pathspecs", "diff", "--no-ext-diff", "--no-textconv", "--no-color", ...staged ? ["--cached"] : [], "--", name]);
        if (output || staged) return output;
        const files = parseStatus(await this.run(["status", "--porcelain=v1", "-z", "--untracked-files=all"]));
        if (!files.some((file) => file.path === name && file.index === "?")) return "";
        const absolute = path.join(this.root, name);
        if ((await fs.lstat(absolute)).isSymbolicLink()) return "(\uC2EC\uBCFC\uB9AD \uB9C1\uD06C)";
        const real = await fs.realpath(absolute);
        const relative = path.relative(await fs.realpath(this.root), real);
        if (relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new Error("\uBCF4\uAD00\uD568 \uBC16\uC758 \uD30C\uC77C\uC740 \uC77D\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
        if ((await fs.stat(real)).size > 2 * 1024 * 1024) return "(2MB\uBCF4\uB2E4 \uD070 \uC0C8 \uD30C\uC77C: \uBBF8\uB9AC\uBCF4\uAE30 \uC0DD\uB7B5)";
        const content = await fs.readFile(real);
        if (content.includes(0)) return "(\uBC14\uC774\uB108\uB9AC \uD30C\uC77C)";
        if (!content.length) return "(\uBE48 \uC0C8 \uD30C\uC77C)";
        const lines = content.toString("utf8").split("\n");
        if (lines.at(-1) === "") lines.pop();
        return lines.map((line) => "+" + line).join("\n");
      }
      async discard(name) {
        await this.requireRepo();
        this.validatePath(name);
        const files = parseStatus(await this.run(["status", "--porcelain=v1", "-z", "--untracked-files=all"]));
        const file = files.find((item) => item.path === name);
        if (!file?.unstaged) return;
        if (file.index === "U" || file.work === "U" || ["AA", "DD"].includes(file.index + file.work)) throw new Error("\uCDA9\uB3CC \uD30C\uC77C\uC740 \uC678\uBD80 Git \uB3C4\uAD6C\uC5D0\uC11C \uD574\uACB0\uD574 \uC8FC\uC138\uC694.");
        if (file.index === "?") {
          if (!this.trash) throw new Error("\uD734\uC9C0\uD1B5\uC744 \uC0AC\uC6A9\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
          await this.trash(name);
        } else {
          await this.run(["--literal-pathspecs", "checkout", "--", name]);
        }
      }
      async commit(message) {
        await this.requireRepo();
        let stats = parseStats(await this.run(["diff", "--cached", "--numstat", "-z"]));
        if (!stats.length) {
          await this.stage();
          stats = parseStats(await this.run(["diff", "--cached", "--numstat", "-z"]));
        }
        if (!stats.length) throw new Error("\uCEE4\uBC0B\uD560 \uBCC0\uACBD\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.");
        stats.sort((a, b) => b.lines - a.lines || a.path.localeCompare(b.path));
        const title = message.trim() || stats[0].path.split("/").pop() + (stats.length > 1 ? " \uB4F1" : "");
        await this.run(["commit", "-m", title]);
        return title;
      }
      async recentFiles() {
        await this.requireRepo();
        if (!await this.hasHead()) return [];
        const output = await this.run(["log", "--first-parent", "-n", "30", "--format=", "--name-only", "-z", "--no-renames", "--diff-filter=AMDT"]);
        const recent = [];
        for (const name of new Set(output.split("\0").filter(Boolean))) {
          this.validatePath(name);
          recent.push(name);
          if (recent.length === 30) break;
        }
        return recent;
      }
      async recentDiff(name) {
        await this.requireRepo();
        this.validatePath(name);
        const commit = (await this.run(["--literal-pathspecs", "log", "--first-parent", "-1", "--format=%H", "--", name])).trim();
        if (!commit) throw new Error("\uC774 \uD30C\uC77C\uC758 \uCEE4\uBC0B \uAE30\uB85D\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4. \uBAA9\uB85D\uC744 \uC0C8\uB85C\uACE0\uCE68\uD574 \uC8FC\uC138\uC694.");
        const diff = await this.run([
          "--literal-pathspecs",
          "show",
          "--format=",
          "--first-parent",
          "--patch",
          "--no-renames",
          "--no-ext-diff",
          "--no-textconv",
          "--no-color",
          commit,
          "--",
          name
        ]);
        return { commit, diff };
      }
      async pull() {
        await this.requireRepo();
        if ((await this.status()).files.length) throw new Error("Pull \uC804\uC5D0 \uBCC0\uACBD\uC0AC\uD56D\uC744 \uCEE4\uBC0B\uD558\uAC70\uB098 \uC815\uB9AC\uD574 \uC8FC\uC138\uC694.");
        return this.run(["pull", "--ff-only"]);
      }
      async push() {
        await this.requireRepo();
        try {
          return await this.run(["push"]);
        } catch (error) {
          if (!/no upstream|has no upstream|set-upstream/i.test(error.message)) throw error;
          const branch = (await this.run(["symbolic-ref", "--short", "HEAD"])).trim();
          const remotes = (await this.run(["remote"])).trim().split("\n").filter(Boolean);
          const remote = remotes.includes("origin") ? "origin" : remotes.length === 1 ? remotes[0] : null;
          if (!remote) throw new Error("\uC6D0\uACA9 \uC800\uC7A5\uC18C\uC640 upstream\uC744 \uBA3C\uC800 \uC124\uC815\uD574 \uC8FC\uC138\uC694.");
          return this.run(["push", "--set-upstream", remote, branch]);
        }
      }
    };
    module2.exports = { GitService: GitService2, parseStatus, parseStats };
  }
});

// src/confirmation.js
var require_confirmation = __commonJS({
  "src/confirmation.js"(exports2, module2) {
    "use strict";
    var { Modal: Modal2 } = require("obsidian");
    var ConfirmationModal = class extends Modal2 {
      constructor(app, options, resolve) {
        super(app);
        this.options = options;
        this.resolve = resolve;
        this.accepted = false;
      }
      onOpen() {
        this.setTitle(this.options.title);
        this.contentEl.createEl("p", { text: this.options.message });
        const actions = this.contentEl.createDiv({ cls: "modal-button-container luggit-confirm-actions" });
        Object.assign(actions.style, { display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "24px", flexWrap: "wrap" });
        const cancel = actions.createEl("button", { text: "\uCDE8\uC18C", attr: { type: "button" } });
        const approve = actions.createEl("button", { text: this.options.confirmLabel, cls: "mod-warning", attr: { type: "button" } });
        cancel.onclick = () => this.close();
        const accept = () => {
          this.accepted = true;
          this.close();
        };
        approve.onclick = accept;
        this.keyHandler = (event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          if (event.isComposing || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
          if (event.target === cancel) return;
          event.preventDefault();
          event.stopPropagation();
          if (!event.repeat) accept();
        };
        this.modalEl.addEventListener("keydown", this.keyHandler);
        approve.focus({ preventScroll: true });
      }
      onClose() {
        this.modalEl.removeEventListener("keydown", this.keyHandler);
        this.contentEl.empty();
        this.resolve(this.accepted);
      }
    };
    function confirmAction2(app, options) {
      return new Promise((resolve) => new ConfirmationModal(app, options, resolve).open());
    }
    module2.exports = { confirmAction: confirmAction2 };
  }
});

// src/exit-guard.js
var require_exit_guard = __commonJS({
  "src/exit-guard.js"(exports2, module2) {
    "use strict";
    function exitWarning(status) {
      if (!status.repo) return "";
      const paths = [.../* @__PURE__ */ new Set([...status.files.map((file) => file.path), ...status.unsaved])];
      if (!paths.length) return "";
      const list = paths.slice(0, 8).join("\n") + (paths.length > 8 ? `
\uC678 ${paths.length - 8}\uAC1C` : "");
      return `\uCEE4\uBC0B\uD558\uC9C0 \uC54A\uC740 \uBCC0\uACBD\uC0AC\uD56D\uC774 ${paths.length}\uAC1C \uC788\uC2B5\uB2C8\uB2E4.

${list}

` + (status.unsaved.length ? "\uC544\uC9C1 \uB514\uC2A4\uD06C \uC800\uC7A5\uC774 \uD655\uC778\uB418\uC9C0 \uC54A\uC740 \uD3B8\uC9D1 \uB0B4\uC6A9\uB3C4 \uC788\uC2B5\uB2C8\uB2E4.\n\n" : "") + "\uCEE4\uBC0B\uD558\uC9C0 \uC54A\uACE0 \uACC4\uC18D \uB2EB\uC744\uAE4C\uC694?\n\uCDE8\uC18C\uB97C \uB204\uB974\uBA74 \uB3CC\uC544\uAC00\uC11C \uCEE4\uBC0B\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4.";
    }
    function guardExit2(event, { busy, inspect, confirm, report }) {
      let message;
      try {
        message = busy ? "Git \uC791\uC5C5\uC774 \uC9C4\uD589 \uC911\uC785\uB2C8\uB2E4. \uC9C0\uAE08 \uB2EB\uC73C\uBA74 \uC791\uC5C5\uC774 \uC911\uB2E8\uB420 \uC218 \uC788\uC2B5\uB2C8\uB2E4. \uACC4\uC18D \uB2EB\uC744\uAE4C\uC694?" : exitWarning(inspect());
      } catch (error) {
        message = `\uC885\uB8CC \uC804 Git \uC0C1\uD0DC\uB97C \uD655\uC778\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.
${error.message}

\uD655\uC778\uD558\uC9C0 \uC54A\uACE0 \uACC4\uC18D \uB2EB\uC744\uAE4C\uC694?`;
      }
      if (!message) return;
      let accepted = false;
      try {
        accepted = confirm(message);
      } catch (error) {
        report(error);
      }
      if (!accepted) {
        event.preventDefault();
        event.returnValue = false;
      }
    }
    module2.exports = { exitWarning, guardExit: guardExit2 };
  }
});

// src/exit-state.js
var require_exit_state = __commonJS({
  "src/exit-state.js"(exports2, module2) {
    "use strict";
    var ExitPushState2 = class {
      constructor(storage, vaultPath, configDir = ".obsidian") {
        this.storage = storage;
        this.key = "luggit:exit-push:" + JSON.stringify([vaultPath, configDir]);
      }
      read() {
        return this.storage.getItem(this.key) || "";
      }
      write(message) {
        if (message) this.storage.setItem(this.key, message);
        else this.storage.removeItem(this.key);
      }
    };
    module2.exports = { ExitPushState: ExitPushState2 };
  }
});

// src/diff.js
var require_diff = __commonJS({
  "src/diff.js"(exports2, module2) {
    "use strict";
    function parseDiff2(text, limit = 3e3) {
      const lines = text.split("\n");
      if (lines.at(-1) === "") lines.pop();
      const allAdded = lines.length > 0 && lines.every((line) => line.startsWith("+"));
      const rows = [];
      let oldLine = 0, newLine = 1, inHunk = allAdded, added = 0, removed = 0, total = 0;
      const append = (row) => {
        total++;
        if (rows.length < limit) rows.push(row);
      };
      for (const line of lines) {
        const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
        if (hunk) {
          oldLine = Number(hunk[1]);
          newLine = Number(hunk[2]);
          inHunk = true;
          append({ type: "hunk", text: `${oldLine ? "\uC774\uC804 " + oldLine + "\uD589" : "\uC0C8 \uBB38\uC11C"} \u2192 ${newLine ? "\uD604\uC7AC " + newLine + "\uD589" : "\uC0AD\uC81C"}` });
        } else if (line.startsWith("diff --git ")) inHunk = false;
        else if (inHunk && /^[ +\-]/.test(line)) {
          const isAdded = line[0] === "+", isRemoved = line[0] === "-";
          if (isAdded) added++;
          if (isRemoved) removed++;
          append({ type: isAdded ? "added" : isRemoved ? "removed" : "context", old: isAdded ? "" : oldLine++, current: isRemoved ? "" : newLine++, sign: line[0], text: line.slice(1) });
        } else if (inHunk && line.startsWith("\\")) append({ type: "hunk", text: "\uD30C\uC77C \uB05D\uC5D0 \uC904\uBC14\uAFC8 \uC5C6\uC74C" });
      }
      let message = "";
      if (!rows.length) {
        if (/Binary files|GIT binary patch|바이너리/.test(text)) message = "\uBC14\uC774\uB108\uB9AC \uD30C\uC77C\uC774 \uBCC0\uACBD\uB418\uC5C8\uC2B5\uB2C8\uB2E4. \uD14D\uC2A4\uD2B8\uB85C \uBE44\uAD50\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.";
        else if (/2MB보다 큰/.test(text)) message = "\uC0C8 \uD30C\uC77C\uC774 2MB\uBCF4\uB2E4 \uCEE4\uC11C \uBBF8\uB9AC\uBCF4\uAE30\uB97C \uC0DD\uB7B5\uD588\uC2B5\uB2C8\uB2E4.";
        else if (/빈 새 파일|new file mode/.test(text)) message = "\uB0B4\uC6A9\uC774 \uC5C6\uB294 \uC0C8 \uD30C\uC77C\uC785\uB2C8\uB2E4.";
        else if (/deleted file mode/.test(text)) message = "\uB0B4\uC6A9\uC774 \uC5C6\uB294 \uD30C\uC77C\uC774 \uC0AD\uC81C\uB418\uC5C8\uC2B5\uB2C8\uB2E4.";
        else if (/심볼릭 링크/.test(text)) message = "\uC2EC\uBCFC\uB9AD \uB9C1\uD06C\uAC00 \uCD94\uAC00\uB418\uC5C8\uC2B5\uB2C8\uB2E4.";
        else if (text.trim()) message = "\uD30C\uC77C \uC774\uB984\uC774\uB098 \uC18D\uC131\uC774 \uBCC0\uACBD\uB418\uC5C8\uC2B5\uB2C8\uB2E4. \uBCF8\uBB38 \uBCC0\uACBD\uC740 \uC5C6\uC2B5\uB2C8\uB2E4.";
        else message = "\uBCF8\uBB38 \uBCC0\uACBD\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.";
      }
      return { rows, added, removed, message, truncated: total > rows.length, limit };
    }
    function copyableDiff2(text) {
      const diff = parseDiff2(text, Infinity);
      return diff.rows.length ? diff.rows.map((row) => row.type === "hunk" ? row.text : row.sign + row.text).join("\n") : diff.message;
    }
    module2.exports = { parseDiff: parseDiff2, copyableDiff: copyableDiff2 };
  }
});

// src/main.js
var { Plugin, ItemView, MarkdownView, TextFileView, Modal, Notice, PluginSettingTab, Setting, FileSystemAdapter, addIcon, setIcon, setTooltip } = require("obsidian");
var { GitService } = require_git_service();
var { confirmAction } = require_confirmation();
var { guardExit } = require_exit_guard();
var { ExitPushState } = require_exit_state();
var { parseDiff, copyableDiff } = require_diff();
var VIEW = "luggit-changes";
var GIT_ICON = "luggit-logo";
var COMMIT_PUSH_ICON = "luggit-commit-push";
var toolbarSequence = 0;
var sectionSequence = 0;
function registerIcons() {
  const wrap = (content) => `<g transform="scale(4.1666666667)" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${content}</g>`;
  addIcon(COMMIT_PUSH_ICON, wrap('<path d="m7 8 5-5 5 5M12 3v9M4 18h5m6 0h5"/><circle cx="12" cy="18" r="3"/>'));
  addIcon(GIT_ICON, '<g transform="scale(1.282051282051282)"><path fill="currentColor" stroke="none" transform="translate(10 10) rotate(-45 29 29)" d="M5,58c-2.76142,0 -5,-2.23858 -5,-5v-48c0,-2.76142 2.23858,-5 5,-5h33v12.54404c-2.06553,0.94801 -3.5,3.03446 -3.5,5.45596c0,0.73514 0.13221,1.43941 0.37415,2.09031l-15.28384,15.28384c-0.6509,-0.24194 -1.35517,-0.37415 -2.09031,-0.37415c-3.31371,0 -6,2.68629 -6,6c0,3.31371 2.68629,6 6,6c3.31371,0 6,-2.68629 6,-6c0,-0.73514 -0.13221,-1.43941 -0.37415,-2.09031l14.87415,-14.87415l0,11.50851c-2.06553,0.94801 -3.5,3.03446 -3.5,5.45596c0,3.31371 2.68629,6 6,6c3.31371,0 6,-2.68629 6,-6c0,-2.42149 -1.43447,-4.50795 -3.5,-5.45596l0,-12.08808c2.06553,-0.94801 3.5,-3.03446 3.5,-5.45596c0,-2.42149 -1.43447,-4.50795 -3.5,-5.45596l0,-12.54404h10c2.76142,0 5,2.23858 5,5v48c0,2.76142 -2.23858,5 -5,5z"/></g>');
}
var fileName = (path) => path.split("/").pop();
function iconButton(parent, icons, label, action) {
  const button = parent.createEl("button", { cls: "luggit-icon", attr: { type: "button", "aria-label": label } });
  setTooltip(button, label, { placement: "bottom" });
  for (const icon of icons) setIcon(button.createSpan({ attr: { "aria-hidden": "true" } }), icon);
  button.onclick = (event) => {
    event.stopPropagation();
    action();
  };
  return button;
}
var DiffModal = class extends Modal {
  constructor(app, name, diff, staged, openFile, contextLabel) {
    super(app);
    this.name = name;
    this.diff = diff;
    this.staged = staged;
    this.openFile = openFile;
    this.contextLabel = contextLabel;
  }
  onOpen() {
    this.setTitle(this.name);
    this.titleEl.empty();
    this.titleEl.createSpan({ text: this.name, cls: "luggit-diff-title-text" });
    if (this.openFile) {
      this.titleEl.addClass("luggit-diff-title");
      this.titleEl.setAttribute("role", "button");
      this.titleEl.setAttribute("tabindex", "0");
      this.titleEl.setAttribute("aria-label", this.name + " \uD3B8\uC9D1\uAE30\uB85C \uC5F4\uAE30");
      setTooltip(this.titleEl, this.name + " \xB7 \uD3B8\uC9D1\uAE30\uB85C \uC5F4\uAE30");
      const open = (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.close();
        this.openFile();
      };
      this.titleEl.onclick = open;
      this.titleEl.onkeydown = (event) => {
        if ((event.key === "Enter" || event.key === " ") && !event.repeat && !event.isComposing && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) open(event);
      };
    }
    this.modalEl.addClass("luggit-diff-modal");
    const diff = parseDiff(this.diff);
    const summary = this.contentEl.createDiv({ cls: "luggit-diff-summary" });
    summary.createSpan({ text: this.contextLabel || (this.staged ? "\uC2A4\uD14C\uC774\uC9C0\uB41C \uBCC0\uACBD" : "\uC791\uC5C5 \uC911\uC778 \uBCC0\uACBD"), cls: "luggit-diff-label" });
    summary.createSpan({ text: `+${diff.added} \uCD94\uAC00`, cls: "luggit-diff-added" });
    summary.createSpan({ text: `\u2212${diff.removed} \uC0AD\uC81C`, cls: "luggit-diff-removed" });
    if (diff.rows.length) {
      const scroll = this.contentEl.createDiv({ cls: "luggit-diff-scroll", attr: { tabindex: "0", "aria-label": "\uBCC0\uACBD \uC804\uD6C4 \uB0B4\uC6A9" } });
      const table = scroll.createEl("table", { cls: "luggit-diff-table" });
      const header = table.createEl("thead").createEl("tr");
      for (const label of ["\uC774\uC804", "\uD604\uC7AC", "", "\uBCC0\uACBD \uB0B4\uC6A9"]) header.createEl("th", { text: label, attr: { scope: "col" } });
      const body = table.createEl("tbody");
      for (const row of diff.rows) {
        const tr = body.createEl("tr", { cls: "is-" + row.type });
        if (row.type === "hunk") tr.createEl("td", { text: row.text, attr: { colspan: "4" } });
        else {
          tr.createEl("td", { text: String(row.old), cls: "luggit-diff-number" });
          tr.createEl("td", { text: String(row.current), cls: "luggit-diff-number" });
          tr.createEl("td", { text: row.sign, cls: "luggit-diff-sign" });
          tr.createEl("td", { text: row.text || " ", cls: "luggit-diff-code" });
        }
      }
    } else this.contentEl.createDiv({ text: diff.message, cls: "luggit-diff-empty" });
    if (diff.truncated) {
      this.contentEl.createEl("p", { text: `\uB0B4\uC6A9\uC774 \uAE38\uC5B4 \uCC98\uC74C ${diff.limit.toLocaleString()}\uC904\uB9CC \uD45C\uC2DC\uD569\uB2C8\uB2E4.`, cls: "luggit-muted" });
    }
    const actions = this.contentEl.createDiv({ cls: "luggit-diff-actions", attr: { role: "group", "aria-label": "\uBE44\uAD50 \uBB38\uC11C \uC791\uC5C5" } });
    iconButton(actions, ["copy"], "\uC81C\uBAA9 \uBCF5\uC0AC (\uACBD\uB85C \uD3EC\uD568)", () => this.copy(this.name));
    iconButton(actions, ["clipboard-list"], "\uBCC0\uACBD \uB0B4\uC6A9 \uBCF5\uC0AC", () => this.copy(copyableDiff(this.diff)));
    if (this.openFile) iconButton(actions, ["file-pen-line"], "\uBB38\uC11C \uC5F4\uAE30", () => {
      this.close();
      this.openFile();
    });
  }
  async copy(text) {
    try {
      await this.contentEl.ownerDocument.defaultView.navigator.clipboard.writeText(text);
      new Notice("\uBCF5\uC0AC\uD588\uC2B5\uB2C8\uB2E4.", 1500);
    } catch (error) {
      new Notice("\uBCF5\uC0AC\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: " + error.message, 6e3);
    }
  }
  onClose() {
    this.contentEl.empty();
  }
};
var GitView = class extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.collapsedSections = /* @__PURE__ */ new Set();
  }
  getViewType() {
    return VIEW;
  }
  getDisplayText() {
    return "Git \uBCC0\uACBD\uC0AC\uD56D";
  }
  getIcon() {
    return GIT_ICON;
  }
  async onOpen() {
    this.contentEl.empty();
    this.contentEl.addClass("luggit");
    const toolbarLabel = "luggit-toolbar-" + ++toolbarSequence;
    const header = this.contentEl.createDiv({ cls: "luggit-header", attr: { role: "toolbar", "aria-labelledby": toolbarLabel } });
    header.createSpan({ text: "Git \uC791\uC5C5", attr: { id: toolbarLabel, hidden: "" } });
    this.commitPushButton = iconButton(header, [COMMIT_PUSH_ICON], "\uCEE4\uBC0B \uD6C4 Push", () => this.plugin.commit(true));
    this.commitButton = iconButton(header, ["git-commit-horizontal"], "\uCEE4\uBC0B", () => this.plugin.commit(false));
    this.stageAllButton = iconButton(header, ["plus"], "\uBAA8\uB450 \uC2A4\uD14C\uC774\uC9C0", () => this.plugin.perform("\uC2A4\uD14C\uC774\uC9C0", () => this.plugin.git.stage()));
    this.unstageAllButton = iconButton(header, ["minus"], "\uBAA8\uB450 \uC2A4\uD14C\uC774\uC9C0 \uD574\uC81C", () => this.plugin.perform("\uC2A4\uD14C\uC774\uC9C0 \uD574\uC81C", () => this.plugin.git.unstage()));
    this.pushButton = iconButton(header, ["arrow-up-from-line"], "Push \xB7 \uCEE4\uBC0B \uC62C\uB9AC\uAE30", () => this.plugin.perform("Push", () => this.plugin.push()));
    this.pullButton = iconButton(header, ["arrow-down-to-line"], "Pull \xB7 \uC6D0\uACA9 \uBCC0\uACBD \uAC00\uC838\uC624\uAE30", () => this.plugin.pullFromRemote());
    this.empty = this.contentEl.createDiv();
    this.empty.createEl("p", { text: "\uC774 \uBCF4\uAD00\uD568\uC740 \uC544\uC9C1 Git \uC800\uC7A5\uC18C\uAC00 \uC544\uB2D9\uB2C8\uB2E4." });
    iconButton(this.empty, ["git-branch-plus"], "\uBCF4\uAD00\uD568\uC5D0 Git \uC800\uC7A5\uC18C \uB9CC\uB4E4\uAE30", () => this.plugin.perform("\uCD08\uAE30\uD654", () => this.plugin.git.init(), false));
    this.body = this.contentEl.createDiv();
    this.message = this.body.createEl("textarea", { cls: "luggit-message", placeholder: "\uCEE4\uBC0B \uBA54\uC2DC\uC9C0 (\uBE44\uC6B0\uBA74 \uD30C\uC77C\uBA85 \uC0AC\uC6A9)", attr: { "aria-label": "\uCEE4\uBC0B \uBA54\uC2DC\uC9C0", rows: "1" } });
    this.message.value = this.plugin.draft;
    this.message.oninput = () => {
      this.plugin.draft = this.message.value;
      this.resizeMessage();
    };
    this.messageObserver?.disconnect();
    let width = 0;
    this.messageObserver = new this.message.ownerDocument.defaultView.ResizeObserver((entries) => {
      const nextWidth = entries[0].contentRect.width;
      if (nextWidth > 0 && nextWidth !== width) {
        width = nextWidth;
        const win = this.message.ownerDocument.defaultView;
        win.cancelAnimationFrame(this.messageResizeFrame);
        this.messageResizeFrame = win.requestAnimationFrame(() => this.resizeMessage());
      }
    });
    this.messageObserver.observe(this.message);
    this.message.onkeydown = (event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing) {
        event.preventDefault();
        this.plugin.commit(false);
      }
    };
    this.staged = this.section("\uC2A4\uD14C\uC774\uC9C0\uB428", [
      ["minus", "\uBAA8\uB450 \uC2A4\uD14C\uC774\uC9C0 \uD574\uC81C", () => this.plugin.perform("\uC2A4\uD14C\uC774\uC9C0 \uD574\uC81C", () => this.plugin.git.unstage())]
    ]);
    this.unstaged = this.section("\uBCC0\uACBD\uB428", [
      ["undo-2", "\uBAA8\uB450 \uBC84\uB9AC\uAE30", () => this.plugin.discard()],
      ["plus", "\uBAA8\uB450 \uC2A4\uD14C\uC774\uC9C0", () => this.plugin.perform("\uC2A4\uD14C\uC774\uC9C0", () => this.plugin.git.stage())]
    ]);
    this.recent = this.section("\uCD5C\uADFC \uBCC0\uACBD\uD55C \uD30C\uC77C", []);
    this.focusHandler = (event) => {
      if (!this.contentEl.contains(event.relatedTarget)) this.plugin.scheduleRefresh();
    };
    this.contentEl.addEventListener("focusin", this.focusHandler);
    this.mouseEnterHandler = () => this.plugin.scheduleRefresh();
    this.contentEl.addEventListener("mouseenter", this.mouseEnterHandler);
    await this.plugin.refresh();
  }
  onClose() {
    this.contentEl.removeEventListener("focusin", this.focusHandler);
    this.contentEl.removeEventListener("mouseenter", this.mouseEnterHandler);
    this.messageObserver?.disconnect();
    this.message?.ownerDocument.defaultView.cancelAnimationFrame(this.messageResizeFrame);
  }
  resizeMessage() {
    if (!this.message?.getClientRects().length) return;
    const css = this.message.ownerDocument.defaultView.getComputedStyle(this.message);
    const border = parseFloat(css.borderTopWidth) + parseFloat(css.borderBottomWidth);
    this.message.style.height = "auto";
    const height = this.message.value ? this.message.scrollHeight : parseFloat(css.lineHeight) + parseFloat(css.paddingTop) + parseFloat(css.paddingBottom);
    this.message.style.height = `${Math.ceil(height + border)}px`;
  }
  section(title, actions) {
    const section = this.body.createDiv({ cls: "luggit-section" });
    const header = section.createDiv({ cls: "luggit-section-header" });
    const listId = "luggit-section-" + ++sectionSequence;
    const toggle = header.createEl("button", { cls: "luggit-section-toggle", attr: { type: "button", "aria-controls": listId } });
    const arrow = toggle.createSpan({ attr: { "aria-hidden": "true" } });
    const label = toggle.createSpan({ text: title, cls: "luggit-section-label" });
    const tools = actions.length ? header.createDiv({ cls: "luggit-actions" }) : null;
    const buttons = actions.map(([icon, name, action]) => iconButton(tools, [icon], name, action));
    const list = section.createDiv({ cls: "luggit-list", attr: { id: listId } });
    const update = () => {
      const collapsed = this.collapsedSections.has(title);
      list.hidden = collapsed;
      toggle.setAttribute("aria-expanded", String(!collapsed));
      setIcon(arrow, collapsed ? "chevron-right" : "chevron-down");
    };
    toggle.onclick = () => {
      if (this.collapsedSections.has(title)) this.collapsedSections.delete(title);
      else this.collapsedSections.add(title);
      update();
    };
    update();
    return { title, label, buttons, list, toggle };
  }
  render(snapshot) {
    if (!this.body) return;
    this.empty.hidden = snapshot.repo;
    this.body.hidden = !snapshot.repo;
    this.message.disabled = this.plugin.busy;
    for (const button of this.contentEl.querySelectorAll(".luggit-icon")) button.disabled = this.plugin.busy;
    for (const button of [this.stageAllButton, this.unstageAllButton, this.commitButton, this.pushButton, this.pullButton, this.commitPushButton]) {
      button.disabled = this.plugin.busy || !snapshot.repo;
      if (!snapshot.repo) button.removeClass("is-pending");
    }
    if (!snapshot.repo) return;
    this.stageAllButton.disabled = this.plugin.busy || !snapshot.files.some((file) => file.unstaged);
    this.unstageAllButton.disabled = this.plugin.busy || !snapshot.files.some((file) => file.staged);
    this.message.value = this.plugin.draft;
    this.resizeMessage();
    this.commitButton.toggleClass("is-pending", snapshot.files.length > 0);
    this.pushButton.toggleClass("is-pending", snapshot.ahead > 0);
    setTooltip(this.pushButton, `Push \xB7 \uB300\uAE30 \uCEE4\uBC0B ${snapshot.ahead}\uAC1C`, { placement: "bottom" });
    this.commitPushButton.toggleClass("is-pending", snapshot.files.length > 0 || snapshot.ahead > 0);
    this.renderFiles(this.staged, snapshot.files.filter((file) => file.staged), true);
    this.renderFiles(this.unstaged, snapshot.files.filter((file) => file.unstaged), false);
    this.recent.list.empty();
    for (const name of snapshot.recent || []) {
      const link = this.recent.list.createEl("a", { text: fileName(name), cls: "luggit-recent", attr: { href: "#" } });
      setTooltip(link, name + " \xB7 \uCD5C\uADFC \uCEE4\uBC0B diff \uBCF4\uAE30");
      link.onclick = (event) => {
        event.preventDefault();
        this.plugin.showRecentDiff(name);
      };
    }
    if (!snapshot.recent?.length) this.recent.list.createDiv({ text: "\uC5C6\uC74C", cls: "luggit-muted" });
  }
  renderFiles(section, files, staged) {
    section.label.setText(`${section.title} (${files.length})`);
    for (const button of section.buttons) button.disabled = this.plugin.busy || !files.length;
    section.list.empty();
    if (!files.length) section.list.createDiv({ text: "\uC5C6\uC74C", cls: "luggit-muted" });
    for (const file of files) {
      const row = section.list.createDiv({ cls: "luggit-file" });
      row.onclick = () => this.plugin.showDiff(file.path, staged);
      const code = staged ? file.index : file.work;
      const statusName = { M: "\uC218\uC815", A: "\uCD94\uAC00", D: "\uC0AD\uC81C", R: "\uC774\uB984 \uBCC0\uACBD", C: "\uBCF5\uC0AC", U: "\uCDA9\uB3CC", T: "\uC720\uD615 \uBCC0\uACBD", "?": "\uCD94\uC801 \uC548 \uB428" }[code] || code;
      const status = row.createSpan({ text: code, cls: "luggit-code", attr: { "data-status": code, "aria-label": statusName } });
      setTooltip(status, statusName);
      const link = row.createEl("a", { text: fileName(file.path), cls: "luggit-path", attr: { href: "#" } });
      setTooltip(link, file.path + " \xB7 diff \uBCF4\uAE30");
      link.onclick = (event) => event.preventDefault();
      const tools = row.createDiv({ cls: "luggit-actions" });
      if (staged) iconButton(tools, ["minus"], "\uC2A4\uD14C\uC774\uC9C0 \uD574\uC81C", () => this.plugin.perform("\uC2A4\uD14C\uC774\uC9C0 \uD574\uC81C", () => this.plugin.git.unstage(file.path)));
      else {
        iconButton(tools, ["undo-2"], "\uBCC0\uACBD \uBC84\uB9AC\uAE30", () => this.plugin.discard(file.path));
        iconButton(tools, ["plus"], "\uC2A4\uD14C\uC774\uC9C0", () => this.plugin.perform("\uC2A4\uD14C\uC774\uC9C0", () => this.plugin.git.stage(file.path)));
      }
      for (const button of tools.querySelectorAll("button")) button.disabled = this.plugin.busy;
    }
  }
};
var GitSettings = class extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    this.containerEl.empty();
    new Setting(this.containerEl).setName("\uC2DC\uC791\uD560 \uB54C Pull").setDesc("\uC6D0\uACA9 \uC800\uC7A5\uC18C\uAC00 \uC788\uACE0 \uBCF4\uAD00\uD568\uC5D0 \uBCC0\uACBD\uC0AC\uD56D\uC774 \uC5C6\uC744 \uB54C\uB9CC \uAC00\uC838\uC635\uB2C8\uB2E4.").addToggle((toggle) => toggle.setValue(this.plugin.settings.autoPull).onChange(async (value) => {
      this.plugin.settings.autoPull = value;
      await this.plugin.saveData(this.plugin.settings);
    }));
    new Setting(this.containerEl).setName("\uC885\uB8CC \uC804 \uBBF8\uCEE4\uBC0B \uBCC0\uACBD \uACBD\uACE0").setDesc("\uCC3D \uB2EB\uAE30\xB7\uC0C8\uB85C\uACE0\uCE68 \uC804\uC5D0 \uB85C\uCEEC \uBCC0\uACBD\uC0AC\uD56D\uC744 \uD655\uC778\uD569\uB2C8\uB2E4. \uAC15\uC81C \uC885\uB8CC\uB294 \uAC10\uC9C0\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.").addToggle((toggle) => toggle.setValue(this.plugin.settings.warnOnExit).onChange(async (value) => {
      this.plugin.settings.warnOnExit = value;
      await this.plugin.saveData(this.plugin.settings);
    }));
    new Setting(this.containerEl).setName("\uC885\uB8CC\uD560 \uB54C Push").setDesc("\uC774\uBBF8 \uB9CC\uB4E4\uC5B4 \uB454 \uCEE4\uBC0B\uB9CC \uCD5C\uB300 15\uCD08 \uB3D9\uC548 Push\uD569\uB2C8\uB2E4. Obsidian\uC758 \uC885\uB8CC \uC774\uBCA4\uD2B8\uAC00 \uC0DD\uB7B5\uB418\uBA74 \uC2E4\uD589\uB418\uC9C0 \uC54A\uC744 \uC218 \uC788\uC2B5\uB2C8\uB2E4.").addToggle((toggle) => toggle.setValue(this.plugin.settings.autoPushOnExit).onChange(async (value) => {
      this.plugin.settings.autoPushOnExit = value;
      await this.plugin.saveData(this.plugin.settings);
    }));
    new Setting(this.containerEl).setName("Git \uC2E4\uD589 \uD30C\uC77C").setDesc("git \uB610\uB294 \uC2E4\uD589 \uD30C\uC77C\uC758 \uC808\uB300 \uACBD\uB85C. \uBCC0\uACBD \uD6C4 \uD50C\uB7EC\uADF8\uC778\uC744 \uB2E4\uC2DC \uCF1C\uC138\uC694.").addText((input) => input.setValue(this.plugin.settings.executable).onChange(async (value) => {
      this.plugin.settings.executable = value.trim() || "git";
      await this.plugin.saveData(this.plugin.settings);
    }));
  }
};
module.exports = class LuggitPlugin extends Plugin {
  async onload() {
    if (!(this.app.vault.adapter instanceof FileSystemAdapter)) {
      new Notice("Luggit\uC740 \uB370\uC2A4\uD06C\uD1B1 \uBCF4\uAD00\uD568\uC5D0\uC11C \uC0AC\uC6A9\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4.");
      return;
    }
    registerIcons();
    this.settings = Object.assign({ autoPull: true, autoPushOnExit: true, warnOnExit: true, executable: "git" }, await this.loadData());
    this.draft = "";
    this.busy = false;
    this.lastRefreshError = "";
    this.refreshId = 0;
    const adapter = this.app.vault.adapter;
    this.exitPushError = "";
    try {
      this.exitState = new ExitPushState(window.localStorage, adapter.getBasePath(), this.app.vault.configDir);
      this.exitPushError = this.exitState.read();
    } catch (error) {
      new Notice("\uC885\uB8CC Push \uC0C1\uD0DC\uB97C \uB85C\uCEEC \uC800\uC7A5\uC18C\uC5D0\uC11C \uC77D\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: " + error.message, 6e3);
    }
    this.git = new GitService(adapter.getBasePath(), { executable: this.settings.executable, trash: async (name) => {
      if (!await adapter.trashSystem(name)) await adapter.trashLocal(name);
    } });
    this.registerView(VIEW, (leaf) => new GitView(leaf, this));
    this.addRibbonIcon(GIT_ICON, "Git \uBCC0\uACBD\uC0AC\uD56D", () => this.openPanel());
    this.addCommand({ id: "open-panel", name: "Git \uBCC0\uACBD\uC0AC\uD56D \uD328\uB110 \uC5F4\uAE30", callback: () => this.openPanel() });
    this.addCommand({ id: "save-stage-current", name: "\uD604\uC7AC \uBB38\uC11C \uC800\uC7A5 \uD6C4 \uC2A4\uD14C\uC774\uC9C0", editorCallback: (_editor, view) => {
      if (view.file) this.perform("\uC800\uC7A5 \uBC0F \uC2A4\uD14C\uC774\uC9C0", () => this.git.stage(view.file.path));
    } });
    this.addCommand({ id: "save-stage-all", name: "\uBAA8\uB450 \uC800\uC7A5 \uD6C4 \uC2A4\uD14C\uC774\uC9C0", callback: () => this.perform("\uBAA8\uB450 \uC2A4\uD14C\uC774\uC9C0", () => this.git.stage()) });
    this.addCommand({ id: "commit", name: "\uCEE4\uBC0B", callback: () => this.commit(false) });
    this.addCommand({ id: "commit-and-push", name: "\uCEE4\uBC0B \uD6C4 Push", callback: () => this.commit(true) });
    this.addCommand({ id: "pull", name: "Pull", callback: () => this.pullFromRemote() });
    this.addCommand({ id: "push", name: "Push", callback: () => this.perform("Push", () => this.push()) });
    this.addSettingTab(new GitSettings(this.app, this));
    for (const name of ["modify", "create", "delete", "rename"]) this.registerEvent(this.app.vault.on(name, () => this.scheduleRefresh()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => {
      if (leaf?.view.getViewType() === VIEW) this.scheduleRefresh();
    }));
    this.registerInterval(window.setInterval(() => this.refresh(), 15e3));
    this.register(() => window.clearTimeout(this.refreshTimer));
    this.register(() => this.progressNotice?.hide());
    this.registerDomEvent(window, "beforeunload", (event) => {
      if (!this.settings.warnOnExit) return;
      guardExit(event, { busy: this.busy, inspect: () => {
        const editors = [];
        this.app.workspace.iterateAllLeaves((leaf) => {
          if (leaf.view instanceof TextFileView && leaf.view.file) editors.push({ path: leaf.view.file.path, content: leaf.view.getViewData() });
        });
        return this.git.statusForExit(editors);
      }, confirm: (message) => window.confirm(message), report: (error) => this.fail(error) });
    });
    this.registerEvent(this.app.workspace.on("quit", (tasks) => {
      if (!this.settings.autoPushOnExit || this.busy) return;
      tasks.add(() => this.pushOnExit());
    }));
    this.app.workspace.onLayoutReady(() => {
      this.openPanel();
      if (this.exitPushError) new Notice("\uC9C0\uB09C \uC885\uB8CC Push: " + this.exitPushError + "\nPush \uBC84\uD2BC\uC73C\uB85C \uB2E4\uC2DC \uC2DC\uB3C4\uD558\uC138\uC694.", 8e3);
      if (this.settings.autoPull) this.perform("\uC790\uB3D9 Pull", async () => {
        const status = await this.git.status();
        if (status.repo && !status.files.length && (await this.git.run(["remote"])).trim()) await this.git.pull();
        else return false;
      });
    });
  }
  async openPanel() {
    try {
      let leaf = this.app.workspace.getLeavesOfType(VIEW)[0];
      if (!leaf) {
        leaf = this.app.workspace.getRightLeaf(false);
        if (!leaf) return;
        await leaf.setViewState({ type: VIEW, active: true });
      }
      await this.app.workspace.revealLeaf(leaf);
    } catch (error) {
      this.fail(error);
    }
  }
  scheduleRefresh() {
    window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => this.refresh(), 500);
  }
  async pullFromRemote() {
    return this.perform("Pull", async () => {
      const status = await this.git.status();
      if (status.repo && (await this.git.run(["remote"])).trim()) await this.git.pull();
    });
  }
  render() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW)) leaf.view.render(this.snapshot || { repo: false, files: [] });
  }
  async refresh(force = false, notify = false) {
    if (this.busy && !force) return;
    const id = ++this.refreshId;
    try {
      const status = await this.git.status();
      if (status.repo) status.recent = await this.git.recentFiles();
      if (id !== this.refreshId) return;
      this.lastRefreshError = "";
      this.snapshot = status;
      this.render();
      if (notify) new Notice("\uBCC0\uACBD\uC0AC\uD56D\uC744 \uC0C8\uB85C\uACE0\uCE68\uD588\uC2B5\uB2C8\uB2E4.", 1500);
    } catch (error) {
      if (id !== this.refreshId) return;
      if (notify || this.lastRefreshError !== error.message) this.fail(error);
      this.lastRefreshError = error.message;
    }
  }
  async saveOpenViews() {
    const views = [];
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view instanceof TextFileView && leaf.view.file) views.push(leaf.view);
    });
    const snapshots = views.map((view) => ({ view, file: view.file, data: view.getViewData() }));
    for (const item of snapshots) {
      if (snapshots.some((other) => other.file === item.file && other.data !== item.data)) throw new Error("\uAC19\uC740 \uD30C\uC77C\uC758 \uD3B8\uC9D1 \uB0B4\uC6A9\uC774 \uC11C\uB85C \uB2E4\uB985\uB2C8\uB2E4. \uBA3C\uC800 \uC800\uC7A5 \uB0B4\uC6A9\uC744 \uC815\uB9AC\uD574 \uC8FC\uC138\uC694.");
      await item.view.save();
    }
    for (const item of snapshots) {
      if (item.view.file !== item.file || item.view.getViewData() !== item.data || await this.app.vault.read(item.file) !== item.data) throw new Error("\uC800\uC7A5 \uC911 \uBB38\uC11C\uAC00 \uBCC0\uACBD\uB418\uC5C8\uC2B5\uB2C8\uB2E4. \uB2E4\uC2DC \uC2E4\uD589\uD574 \uC8FC\uC138\uC694.");
    }
  }
  async perform(label, action, save = true) {
    if (this.busy) return;
    this.busy = true;
    ++this.refreshId;
    this.render();
    const progress = this.progressNotice = new Notice(label + " \uC911\u2026", 0);
    try {
      if (save) await this.saveOpenViews();
      const result = await action();
      if (result !== false) new Notice(label + " \uC644\uB8CC", 1500);
    } catch (error) {
      this.fail(error);
    } finally {
      progress.hide();
      this.progressNotice = null;
      this.busy = false;
      await this.refresh();
    }
  }
  fail(error) {
    new Notice(error.message, 6e3);
    this.render();
  }
  recordExitPushError(message) {
    this.exitPushError = message;
    try {
      this.exitState.write(message);
    } catch (error) {
      new Notice("\uC885\uB8CC Push \uC0C1\uD0DC\uB97C \uB85C\uCEEC\uC5D0 \uC800\uC7A5\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: " + error.message, 6e3);
    }
  }
  async pushOnExit() {
    try {
      const status = await this.git.status();
      if (!status.repo || !status.ahead) return;
      this.recordExitPushError("Push \uC644\uB8CC\uB97C \uD655\uC778\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.");
      await this.git.pushOnExit();
      this.recordExitPushError("");
    } catch (error) {
      this.recordExitPushError(error.message);
    }
  }
  async push() {
    await this.git.push();
    this.recordExitPushError("");
  }
  async commit(push) {
    return this.perform(push ? "\uCEE4\uBC0B \uD6C4 Push" : "\uCEE4\uBC0B", async () => {
      await this.git.commit(this.draft);
      this.draft = "";
      if (push) {
        try {
          await this.push();
        } catch (error) {
          throw new Error("\uCEE4\uBC0B\uC740 \uC644\uB8CC\uB410\uC9C0\uB9CC Push\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4. Push \uBC84\uD2BC\uC73C\uB85C \uB2E4\uC2DC \uC2DC\uB3C4\uD558\uC138\uC694.\n" + error.message);
        }
      }
    });
  }
  async showDiff(name, staged) {
    if (this.busy) return;
    try {
      new DiffModal(
        this.app,
        name,
        await this.git.diff(name, staged),
        staged,
        this.app.vault.getFileByPath(name) ? () => this.openFile(name) : null
      ).open();
    } catch (error) {
      this.fail(error);
    }
  }
  async openFile(name) {
    try {
      const file = this.app.vault.getFileByPath(name);
      if (!file) throw new Error("\uBCF4\uAD00\uD568\uC5D0\uC11C \uD30C\uC77C\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
      await this.app.workspace.getLeaf(false).openFile(file, { state: { mode: "source" } });
    } catch (error) {
      this.fail(error);
    }
  }
  async showRecentDiff(name) {
    if (this.busy) return;
    try {
      const { commit, diff } = await this.git.recentDiff(name);
      new DiffModal(
        this.app,
        name,
        diff,
        false,
        this.app.vault.getFileByPath(name) ? () => this.openFile(name) : null,
        "\uCD5C\uADFC \uBCC0\uACBD \uCEE4\uBC0B \xB7 " + commit.slice(0, 7)
      ).open();
    } catch (error) {
      this.fail(error);
    }
  }
  async discard(name) {
    return this.perform("\uBCC0\uACBD \uBC84\uB9AC\uAE30", async () => {
      const status = await this.git.status();
      const files = status.files.filter((file) => file.unstaged && (!name || file.path === name));
      if (!files.length) return false;
      const views = this.app.workspace.getLeavesOfType("markdown").map((leaf) => leaf.view).filter((view) => view instanceof MarkdownView && files.some((file) => file.path === view.file?.path)).map((view) => ({ view, file: view.file, content: view.editor.getValue() }));
      const message = `${name || files.length + "\uAC1C \uD30C\uC77C"}\uC758 \uC2A4\uD14C\uC774\uC9C0\uB418\uC9C0 \uC54A\uC740 \uBCC0\uACBD\uC744 \uBC84\uB9B4\uAE4C\uC694? \uC0C8 \uD30C\uC77C\uC740 \uD734\uC9C0\uD1B5\uC73C\uB85C \uBCF4\uB0C5\uB2C8\uB2E4.`;
      if (!await confirmAction(this.app, { title: "\uBCC0\uACBD \uBC84\uB9AC\uAE30", message, confirmLabel: name ? "\uBCC0\uACBD \uBC84\uB9AC\uAE30" : "\uBAA8\uB450 \uBC84\uB9AC\uAE30" })) return false;
      for (const item of views) if (item.view.file !== item.file || item.view.editor.getValue() !== item.content) throw new Error("\uD655\uC778 \uC911 \uBB38\uC11C\uAC00 \uBCC0\uACBD\uB418\uC5B4 \uCDE8\uC18C\uD588\uC2B5\uB2C8\uB2E4.");
      const current = (await this.git.status()).files.filter((file) => file.unstaged && (!name || file.path === name));
      if (JSON.stringify(files) !== JSON.stringify(current)) throw new Error("Git \uC0C1\uD0DC\uAC00 \uBCC0\uACBD\uB418\uC5C8\uC2B5\uB2C8\uB2E4. \uB2E4\uC2DC \uD655\uC778\uD574 \uC8FC\uC138\uC694.");
      for (const file of files) {
        await this.git.discard(file.path);
        for (const item of views.filter((item2) => item2.file.path === file.path)) {
          if (item.view.file !== item.file || item.view.editor.getValue() !== item.content) continue;
          if (file.index === "?") item.view.leaf.detach();
          else {
            const data = await this.app.vault.read(item.file);
            if (item.view.file === item.file && item.view.editor.getValue() === item.content) item.view.setViewData(data, false);
          }
        }
      }
    });
  }
};
/*! Git logomark by Jason Long, CC BY 3.0. https://git-scm.com/community/logos
 * Official SVG geometry; only scaled from 78 to 100 units and recolored for the host theme.
 * https://creativecommons.org/licenses/by/3.0/ */
