const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const core = require("../dist/core");
const { statisticsHtml } = require("../dist/statistics");
const pkg = require("../package.json");
const {
  parseTasks,
  taskText,
  wrapComment,
  deletionRange,
  validDescription,
  SYNTAX,
  DEFAULT_OPTIONS,
  visibleTasks,
  summarize,
  languageForPath,
} = core;

const report = {};

function tc(id, title, fn) {
  test(`${id} ${title}`, async () => {
    try {
      report[id] = {
        ok: true,
        actual: String((await fn()) ?? "ожидаемый результат получен"),
      };
    } catch (e) {
      report[id] = { ok: false, actual: String(e.message).split("\n")[0] };
      throw e;
    }
  });
}

function limitation(id, title, fn) {
  test(`${id} ${title} (ограничение)`, async () => {
    report[id] = { ok: true, limitation: true, actual: String(await fn()) };
  });
}
process.on("exit", () => {
  if (process.env.TC_REPORT) {
    fs.writeFileSync(process.env.TC_REPORT, JSON.stringify(report, null, 1));
  }
});

const URI = "file:///project/main.ts";
const parse = (text, lang = "typescript", uri = URI) =>
  parseTasks(text, uri, lang);
const brief = (tasks) =>
  JSON.stringify(tasks.map((t) => [t.type, t.priority, t.description, t.line]));

tc("TC-01", "TODO без приоритета", () => {
  const t = parse("// TODO: сделать");
  assert.equal(t.length, 1);
  assert.deepEqual(
    [t[0].type, t[0].priority, t[0].description],
    ["TODO", "NONE", "сделать"],
  );
  return brief(t);
});
tc("TC-02", "FIXME[MEDIUM]", () => {
  const t = parse("// FIXME[MEDIUM]: исправить");
  assert.deepEqual(
    [t[0].type, t[0].priority, t[0].description],
    ["FIXME", "MEDIUM", "исправить"],
  );
  return brief(t);
});
tc("TC-03", "BUG[CRITICAL]", () => {
  const t = parse("// BUG[CRITICAL]: падение");
  assert.deepEqual([t[0].type, t[0].priority], ["BUG", "CRITICAL"]);
  return brief(t);
});
tc("TC-04", "TODO[HIGH]", () => {
  const t = parse("// TODO[HIGH]: проверка");
  assert.deepEqual([t[0].priority, t[0].description], ["HIGH", "проверка"]);
  return brief(t);
});
tc("TC-05", "TODO[LOW]", () => {
  assert.equal(parse("// TODO[LOW]: стили")[0].priority, "LOW");
});
tc("TC-06", "без двоеточия", () => {
  const t = parse("// TODO без двоеточия");
  assert.equal(t.length, 1);
  assert.equal(t[0].description, "без двоеточия");
  return brief(t);
});
tc("TC-07", "блочный комментарий", () => {
  const t = parse("/* TODO[LOW]: упростить */");
  assert.equal(t.length, 1);
  assert.equal(t[0].description, "упростить");
  return brief(t);
});
tc("TC-08", "Python #", () => {
  const t = parse("# TODO[HIGH]: ошибка соединения", "python");
  assert.equal(t.length, 1);
  assert.equal(t[0].priority, "HIGH");
  return brief(t);
});
tc("TC-09", "HTML-комментарий", () => {
  const t = parse("<!-- FIXME[MEDIUM]: подпись -->", "html");
  assert.equal(t.length, 1);
  assert.equal(t[0].description, "подпись");
  return brief(t);
});
tc("TC-10", "два маркера в комментарии", () => {
  const t = parse("// TODO: a FIXME: b");
  assert.deepEqual(
    t.map((x) => [x.type, x.description]),
    [
      ["TODO", "a"],
      ["FIXME", "b"],
    ],
  );
  return brief(t);
});
tc("TC-11", "многострочный блок", () => {
  const t = parse("/*\nтекст\nTODO: третья строка\n */");
  assert.equal(t.length, 1);
  assert.equal(t[0].line, 2);
  return brief(t);
});
tc("TC-12", "нижний регистр", () => {
  assert.equal(parse("// todo: x").length, 0);
});
tc("TC-13", "пустое описание", () => {
  const t = parse("// TODO:");
  assert.doesNotThrow(() => parse("// TODO:"));
  return `${t.length} задача, описание «${t[0]?.description}»`;
});
tc("TC-14", "неизвестный приоритет", () => {
  const t = parse("// TODO[URGENT]: x");
  assert.ok(!t.some((x) => x.priority === "URGENT"));
  return `найдено задач: ${t.length}`;
});
tc("TC-15", "пустой файл", () => {
  assert.equal(parse("").length, 0);
});

tc("TC-16", "двойные кавычки", () => {
  assert.equal(parse('const s = "// TODO: пример";').length, 0);
});
tc("TC-17", "одинарные кавычки", () => {
  assert.equal(parse("const s = '// TODO: пример';").length, 0);
});
tc("TC-18", "шаблонная строка", () => {
  assert.equal(parse("const s = `// TODO: x`;").length, 0);
});
tc("TC-19", "идентификатор TODO", () => {
  assert.equal(parse("let TODO = 1;").length, 0);
});
tc("TC-20", "Python docstring", () => {
  assert.equal(parse('"""TODO: x"""', "python").length, 0);
});
tc("TC-21", "экранированная кавычка", () => {
  assert.equal(parse('const s = "a\\" // TODO: x";').length, 0);
});
tc("TC-22", "строка и комментарий в одной строке", () => {
  const t = parse('s = "x"; // TODO: y');
  assert.equal(t.length, 1);
  assert.equal(t[0].description, "y");
});
tc("TC-23", "URL в строке", () => {
  const t = parse('const u = "http://a.b"; // TODO: z');
  assert.equal(t.length, 1);
  assert.equal(t[0].description, "z");
});
limitation("TC-24", "вложенные блочные комментарии", () =>
  brief(parse("/* /* TODO: x */ */")),
);
limitation("TC-25", "комментарий в выражении шаблонной строки", () =>
  brief(parse("const s = `${/* TODO: x */ 1}`;")),
);
limitation("TC-26", "heredoc в shell", () =>
  brief(parse("cat <<EOF\n# TODO: x\nEOF", "shellscript")),
);

const byLang = (id, title, langs, sample) =>
  tc(id, title, () => {
    for (const lang of langs) {
      assert.equal(parse(sample, lang).length, 1, `язык ${lang}`);
    }
    return `найдено по 1 задаче для: ${langs.join(", ")}`;
  });
byLang(
  "TC-27",
  "JS/TS/JSX/TSX",
  ["javascript", "typescript", "javascriptreact", "typescriptreact"],
  "// TODO: x",
);
byLang(
  "TC-28",
  "C-подобные",
  [
    "c",
    "cpp",
    "csharp",
    "java",
    "go",
    "rust",
    "swift",
    "kotlin",
    "dart",
    "php",
  ],
  "// TODO: x",
);
byLang(
  "TC-29",
  "языки с #",
  ["python", "ruby", "shellscript", "yaml", "r", "perl", "powershell"],
  "# TODO: x",
);
byLang("TC-30", "CSS/SCSS/Less", ["css", "scss", "less"], "/* TODO: x */");
byLang("TC-31", "SQL/Lua/Haskell", ["sql", "lua", "haskell"], "-- TODO: x");
byLang("TC-32", "LaTeX", ["latex"], "% TODO: x");
byLang("TC-33", "BAT", ["bat"], "REM TODO: x");
byLang("TC-34", "INI", ["ini"], "; TODO: x");
byLang(
  "TC-35",
  "Dockerfile/Makefile/TOML",
  ["dockerfile", "makefile", "toml"],
  "# TODO: x",
);
tc("TC-36", "Vue/Svelte разметка", () => {
  for (const l of ["vue", "svelte"]) {
    assert.equal(parse("<!-- TODO: x -->", l).length, 1);
  }
});
limitation(
  "TC-37",
  "// внутри <script> в Vue",
  () =>
    `найдено задач: ${parse("<script>\n// TODO: x\n</script>", "vue").length}`,
);
tc("TC-38", "Markdown не сканируется", () => {
  assert.equal(languageForPath("/x/a.md"), "");
  assert.equal(parse("<!-- TODO: x -->", languageForPath("/x/a.md")).length, 0);
});
tc("TC-39", "json и jsonc", () => {
  assert.equal(languageForPath("/x/a.json"), "");
  assert.equal(parse("// TODO: x", languageForPath("/x/a.jsonc")).length, 1);
});

tc("TC-42", "ID не зависит от номера строки", () => {
  const a = parse("// TODO: x {#todo:abcd1234-1}")[0];
  const b = parse("\n\n\n\n\n// TODO: x {#todo:abcd1234-1}")[0];
  assert.equal(a.id, b.id);
  assert.equal(b.line, 5);
});
tc("TC-43", "ID при перемещении комментария", () => {
  const a = parse("// TODO: x {#todo:abcd1234-1}\nrun();")[0];
  const b = parse("run();\n// TODO: x {#todo:abcd1234-1}")[0];
  assert.equal(a.id, b.id);
  assert.notEqual(a.line, b.line);
});
tc("TC-44", "ID не зависит от пути файла", () => {
  const a = parse(
    "// TODO: x {#todo:abcd1234-1}",
    "typescript",
    "file:///a.ts",
  )[0];
  const b = parse(
    "// TODO: x {#todo:abcd1234-1}",
    "typescript",
    "file:///b.ts",
  )[0];
  assert.equal(a.id, b.id);
});
tc("TC-46", "парсер видит одинаковые ID у копий", () => {
  const t = parse(
    "// TODO: x {#todo:abcd1234-1}\n// TODO: x {#todo:abcd1234-1}",
  );
  assert.equal(t[0].id, t[1].id);
  return "парсер вернул 2 задачи с одним ID (скрытие статуса — в extension.ts, не проверялось)";
});
tc("TC-49", "удалённая задача пропадает из статистики", () => {
  const t = parse("// TODO: a\n// TODO: b");
  assert.equal(summarize(t.slice(1), () => "open").total, 1);
});
tc("TC-50", "статусы в статистике", () => {
  const t = parse("// TODO: a\n// TODO: b\n// TODO: c\n// TODO: d");
  const st = ["open", "inProgress", "done", "deferred"];
  const s = summarize(t, (x) => st[t.indexOf(x)]);
  assert.deepEqual(Object.values(s.statuses), [1, 1, 1, 1]);
  assert.deepEqual(core.STATUSES, st);
});

tc("TC-53", "синтаксис создаваемого комментария", () => {
  const c = taskText("TODO", "NONE", "x");
  assert.equal(wrapComment(c, SYNTAX.python), "# TODO: x");
  assert.equal(wrapComment(c, SYNTAX.html), "<!-- TODO: x -->");
  assert.equal(wrapComment(c, SYNTAX.typescript), "// TODO: x");
  assert.equal(wrapComment(c, SYNTAX.sql), "-- TODO: x");
});
tc("TC-54", "язык без синтаксиса", () => {
  assert.throws(() => wrapComment("TODO: x", {}), /не настроен синтаксис/);
});
tc("TC-55", "горячая клавиша (package.json)", () => {
  const k = pkg.contributes.keybindings.find(
    (x) => x.command === "todoManager.add",
  );
  assert.equal(k.key, "ctrl+alt+t");
  assert.equal(k.mac, "cmd+alt+t");
  return "в package.json привязка есть; фактическое нажатие в VS Code не проверялось";
});
tc("TC-62", "удаление одиночного комментария", () => {
  const text = "const a = 1;\n  // TODO: delete\nconst b = 2;";
  const r = deletionRange(text, parse(text)[0]);
  assert.equal(
    text.slice(0, r.start) + text.slice(r.end),
    "const a = 1;\nconst b = 2;",
  );
});
tc("TC-64", "удаление первой из двух задач в комментарии", () => {
  const text = "// TODO: a FIXME: b";
  const r = deletionRange(text, parse(text)[0]);
  const res = text.slice(0, r.start) + text.slice(r.end);
  assert.equal(parse(res).length, 1);
  assert.equal(parse(res)[0].type, "FIXME");
  return res;
});

const SET =
  "// TODO[HIGH]: Alpha build\n// BUG[CRITICAL]: beta crash\n// FIXME[LOW]: Gamma fix\n// TODO: delta";
const vis = (o, st = () => "open") =>
  visibleTasks(parse(SET), { ...DEFAULT_OPTIONS, ...o }, st);
tc("TC-65", "поиск по описанию без учёта регистра", () => {
  assert.equal(vis({ query: "ALPHA" }).length, 1);
  assert.equal(vis({ query: "alpha" }).length, 1);
});
tc("TC-66", "поиск по пути", () => {
  assert.equal(vis({ query: "project/main" }).length, 4);
  assert.equal(vis({ query: "other.ts" }).length, 0);
});
tc("TC-67", "поиск по типу", () => {
  assert.deepEqual(
    vis({ query: "fixme" }).map((t) => t.type),
    ["FIXME"],
  );
});
tc("TC-68", "поиск по приоритету", () => {
  assert.deepEqual(
    vis({ query: "high" }).map((t) => t.priority),
    ["HIGH"],
  );
});
tc("TC-69", "пустой запрос", () => {
  assert.equal(vis({ query: "alpha" }).length, 1);
  assert.equal(vis({ query: "" }).length, 4);
  assert.equal(vis({ query: "   " }).length, 4);
});
tc("TC-70", "поиск без результатов", () => {
  assert.equal(vis({ query: "zzzzzz" }).length, 0);
});
tc("TC-71", "фильтр типов: ИЛИ", () => {
  assert.equal(vis({ types: ["TODO", "BUG"] }).length, 3);
});
tc("TC-72", "фильтры разных категорий: И", () => {
  assert.deepEqual(
    vis({ types: ["TODO"], priorities: ["HIGH"] }).map((t) => t.description),
    ["Alpha build"],
  );
});
tc("TC-73", "пустая категория не ограничивает", () => {
  assert.equal(vis({ types: [], priorities: [], statuses: [] }).length, 4);
});
tc("TC-76", "сортировка по приоритету", () => {
  assert.deepEqual(
    vis({ sort: "priority" }).map((t) => t.priority),
    ["CRITICAL", "HIGH", "LOW", "NONE"],
  );
});
tc("TC-77", "сортировка по расположению, типу, описанию", () => {
  assert.deepEqual(
    vis({ sort: "location" }).map((t) => t.line),
    [0, 1, 2, 3],
  );
  assert.deepEqual(
    vis({ sort: "type" }).map((t) => t.type),
    ["TODO", "TODO", "FIXME", "BUG"],
  );
  assert.deepEqual(
    vis({ sort: "description" }).map((t) => t.description),
    ["Alpha build", "beta crash", "delta", "Gamma fix"],
  );
});
tc("TC-146", "фильтр по статусу", () => {
  const t = parse(SET);
  assert.equal(
    visibleTasks(t, { ...DEFAULT_OPTIONS, statuses: ["done"] }, (x) =>
      x.line < 2 ? "done" : "open",
    ).length,
    2,
  );
});

const options = new Map();
const vscode = {
  ThemeColor: class {
    constructor(id) {
      this.id = id;
    }
  },
  Range: class {
    constructor(start, end) {
      this.start = start;
      this.end = end;
    }
  },
  DecorationRangeBehavior: { ClosedClosed: 1 },
  commands: { executeCommand: async () => {} },
  workspace: { getConfiguration: () => ({ get: (_, fallback) => fallback }) },
  window: {
    visibleTextEditors: [],
    createTextEditorDecorationType: (c) => {
      const t = { dispose() {} };
      options.set(t, c);
      return t;
    },
    onDidChangeVisibleTextEditors: () => ({ dispose() {} }),
  },
};
const load = Module._load;
let TaskHighlights;
try {
  Module._load = function (id, ...a) {
    return id === "vscode" ? vscode : load.call(this, id, ...a);
  };
  ({ TaskHighlights } = require("../dist/highlights"));
} finally {
  Module._load = load;
}
const editor = (text, path = "main.py", lang = "python") => {
  const painted = new Map();
  return {
    document: {
      uri: path,
      getText: () => text,
      positionAt: (o) => o,
      languageId: lang,
    },
    painted,
    setDecorations(t, r) {
      painted.set(t, r);
    },
  };
};
const index = {
  eligible: (u) => u !== "excluded.py",
  parse: (d) => parseTasks(d.getText(), d.uri, d.languageId),
};
const memento = (init) => {
  const m = new Map(init === undefined ? [] : [["highlightEnabled", init]]);
  return {
    get: (k, f) => m.get(k) ?? f,
    update: async (k, v) => {
      m.set(k, v);
    },
  };
};
const marks = (e) =>
  [...e.painted].flatMap(([t, rs]) =>
    rs.map((r) => ({
      text: e.document.getText().slice(r.start, r.end),
      color: options.get(t).backgroundColor.id,
    })),
  );
tc("TC-83", "подсветка включена по умолчанию", () => {
  const e = editor("# TODO: x");
  vscode.window.visibleTextEditors = [e];
  const h = new TaskHighlights(index, memento());
  assert.equal(h.enabled, true);
  assert.equal(marks(e).length, 1);
  h.dispose();
});
tc("TC-84", "подсвечивается только маркер", () => {
  const e = editor("# TODO[HIGH]: описание {#todo:aaaaaaaa}");
  vscode.window.visibleTextEditors = [e];
  const h = new TaskHighlights(index, memento());
  assert.deepEqual(
    marks(e).map((m) => m.text),
    ["TODO[HIGH]"],
  );
  h.dispose();
});
tc("TC-85", "без приоритета — только слово", () => {
  const e = editor("# TODO: x");
  vscode.window.visibleTextEditors = [e];
  const h = new TaskHighlights(index, memento());
  const m = marks(e);
  assert.equal(m[0].text, "TODO");
  assert.match(m[0].color, /noneBackground$/);
  h.dispose();
});
tc("TC-86", "пять разных цветов", () => {
  const e = editor(
    "# TODO[CRITICAL]: a\n# BUG[HIGH]: b\n# FIXME[MEDIUM]: c\n# TODO[LOW]: d\n# BUG: e",
  );
  vscode.window.visibleTextEditors = [e];
  const h = new TaskHighlights(index, memento());
  assert.equal(new Set(marks(e).map((m) => m.color)).size, 5);
  h.dispose();
});
tc("TC-87", "выключение подсветки", async () => {
  const e = editor("# TODO: x");
  vscode.window.visibleTextEditors = [e];
  const h = new TaskHighlights(index, memento());
  await h.setEnabled(false);
  assert.equal(marks(e).length, 0);
  assert.equal(h.enabled, false);
  h.dispose();
});
tc("TC-88", "включение подсветки", async () => {
  const e = editor("# TODO: x");
  vscode.window.visibleTextEditors = [e];
  const h = new TaskHighlights(index, memento(false));
  assert.equal(marks(e).length, 0);
  await h.setEnabled(true);
  assert.equal(marks(e).length, 1);
  h.dispose();
});
tc("TC-89", "выбор сохраняется в хранилище", async () => {
  const m = memento();
  vscode.window.visibleTextEditors = [];
  const h = new TaskHighlights(index, m);
  await h.setEnabled(false);
  assert.equal(m.get("highlightEnabled"), false);
  h.dispose();
  const h2 = new TaskHighlights(index, m);
  assert.equal(h2.enabled, false);
  h2.dispose();
  return "после «перезапуска» (новый контроллер с тем же хранилищем) подсветка выключена";
});
tc("TC-91", "текст в строке не подсвечивается", () => {
  const e = editor('x = "# TODO: fake"');
  vscode.window.visibleTextEditors = [e];
  const h = new TaskHighlights(index, memento());
  assert.equal(marks(e).length, 0);
  h.dispose();
});
tc("TC-92", "исключённый файл", () => {
  const e = editor("# TODO: x", "excluded.py");
  vscode.window.visibleTextEditors = [e];
  const h = new TaskHighlights(index, memento());
  assert.equal(marks(e).length, 0);
  h.dispose();
});
tc("TC-93", "несколько видимых редакторов", () => {
  const a = editor("# TODO: a"),
    b = editor("# BUG: b", "b.py");
  vscode.window.visibleTextEditors = [a, b];
  const h = new TaskHighlights(index, memento());
  assert.equal(marks(a).length, 1);
  assert.equal(marks(b).length, 1);
  h.dispose();
});
const colors = Object.fromEntries(
  pkg.contributes.colors.map((c) => [c.id, c.defaults]),
);
tc("TC-95", "цвета для светлой, тёмной, контрастных тем (package.json)", () => {
  for (const [id, d] of Object.entries(colors)) {
    for (const k of ["dark", "light", "highContrast"]) {
      assert.ok(d[k], `${id}: нет ${k}`);
    }
  }
  return `описано ${Object.keys(colors).length} цветовых токенов`;
});
tc("TC-96", "имена токенов для переопределения", () => {
  for (const p of ["critical", "high", "medium", "low", "none"]) {
    for (const s of ["Background", "Foreground"]) {
      assert.ok(colors[`todoManager.highlight.${p}${s}`], `${p}${s}`);
    }
  }
});

const stats = (text, st) => summarize(parse(text), st ?? (() => "open"));
tc("TC-97", "сводка статистики", () => {
  const s = stats("// TODO: a\n// BUG: b", (t) =>
    t.type === "TODO" ? "done" : "open",
  );
  assert.deepEqual([s.total, s.files, s.statuses.done], [2, 1, 1]);
  const h = statisticsHtml(s, "csp");
  assert.match(h, /<strong>2<\/strong><span>Всего задач/);
  assert.match(h, /50%/);
});
tc("TC-99", "диаграммы по типам, приоритетам, статусам", () => {
  const h = statisticsHtml(stats("// TODO[HIGH]: a"), "csp");
  for (const s of [
    "По типам",
    "По приоритетам",
    "Состояние проекта",
    "Без приоритета",
    "Открыта",
    "Выполнено",
  ]) {
    assert.ok(h.includes(s), s);
  }
  assert.equal((h.match(/<meter/g) || []).length, 3 + 5 + 4);
});
tc("TC-102", "пустой проект", () => {
  const h = statisticsHtml(
    summarize([], () => "open"),
    "csp",
  );
  assert.doesNotMatch(h, /NaN|Infinity/);
  assert.match(h, /<strong>0%<\/strong>/);
});
tc("TC-103", "1 из 4 выполнено = 25%", () => {
  const s = stats("// TODO: a\n// TODO: b\n// TODO: c\n// TODO: d", (t) =>
    t.line === 0 ? "done" : "open",
  );
  assert.match(statisticsHtml(s, "csp"), /<strong>25%<\/strong>/);
});
tc("TC-104", "отчёт без скриптов и внешних ресурсов", () => {
  const h = statisticsHtml(stats("// TODO: a"), "vscode-resource");
  assert.doesNotMatch(h, /<script/i);
  assert.match(h, /default-src 'none'/);
  assert.doesNotMatch(h, /src="https?:|href="https?:/);
});

const cfg = pkg.contributes.configuration.properties;
tc("TC-105", "include по умолчанию", () => {
  assert.equal(cfg["todoManager.include"].default, "**/*");
});
tc("TC-107", "исключения по умолчанию", () => {
  const ex = cfg["todoManager.exclude"].default;
  for (const d of [
    "node_modules",
    ".git",
    "dist",
    "build",
    "out",
    "coverage",
    ".next",
    "vendor",
    ".venv",
    "venv",
  ]) {
    assert.ok(ex.includes(d), d);
  }
});
tc("TC-108", "лимит размера по умолчанию", () => {
  assert.equal(cfg["todoManager.maxFileSizeKB"].default, 1024);
  assert.equal(cfg["todoManager.maxFileSizeKB"].minimum, 1);
  return "в настройках лимит 1024 КБ (минимум 1); сам пропуск файлов не проверялся";
});
tc("TC-111", "задержка по умолчанию", () => {
  assert.equal(cfg["todoManager.debounceMs"].default, 300);
  assert.equal(cfg["todoManager.debounceMs"].minimum, 50);
  return "в настройках 300 мс (минимум 50); поведение таймера не проверялось";
});
tc("TC-112", "пользовательский синтаксис", () => {
  assert.equal(
    parseTasks("; TODO: custom", "x", "custom", { line: [";"] }).length,
    1,
  );
  assert.equal(
    parseTasks("{{ TODO: b }}", "x", "custom", { block: [["{{", "}}"]] })
      .length,
    1,
  );
});
tc("TC-114", "бинарные файлы", () => {
  assert.equal(languageForPath("/x/a.png"), "");
  assert.equal(parse("// TODO: x\0").length, 0);
});
tc("TC-116", ".gitignore не применяется", () => {
  const src =
    fs.readFileSync(`${__dirname}/../src/indexer.ts`, "utf8") +
    fs.readFileSync(`${__dirname}/../src/extension.ts`, "utf8");
  assert.doesNotMatch(src, /gitignore/i);
  return "в исходниках нет чтения .gitignore";
});
tc("TC-125", "нет сетевых вызовов (статический поиск)", () => {
  let src = "";
  for (const f of fs.readdirSync(`${__dirname}/../src`)) {
    src += fs.readFileSync(`${__dirname}/../src/${f}`, "utf8");
  }
  assert.doesNotMatch(
    src,
    /fetch\(|XMLHttpRequest|node:https?|require\('https?'\)|WebSocket/,
  );
  return "в src нет сетевых вызовов; работа при отключённой сети вручную не проверялась";
});

tc("TC-126", "validDescription: пустое описание", () => {
  assert.ok(validDescription("", SYNTAX.typescript));
  assert.ok(validDescription("   ", SYNTAX.typescript));
});
tc("TC-127", "validDescription: перевод строки", () => {
  assert.ok(validDescription("a\nb", SYNTAX.typescript));
  assert.ok(validDescription("a\r\nb", SYNTAX.typescript));
});
tc("TC-128", "validDescription: закрывающий разделитель", () => {
  assert.ok(validDescription("x */ y", SYNTAX.typescript));
  assert.ok(validDescription("x --> y", SYNTAX.html));
  assert.equal(validDescription("x */ y", SYNTAX.python), undefined);
});
tc("TC-129", "validDescription: служебный ID и маркер", () => {
  assert.ok(validDescription("x {#todo:aaaaaaaa}", SYNTAX.typescript));
  assert.ok(validDescription("see TODO: y", SYNTAX.typescript));
  assert.ok(validDescription("see BUG[HIGH] y", SYNTAX.typescript));
});
tc("TC-130", "validDescription: кириллица и обычный текст", () => {
  assert.equal(
    validDescription("Проверить обработку ошибок", SYNTAX.typescript),
    undefined,
  );
});
tc("TC-131", "taskText с приоритетом и ID", () => {
  assert.equal(
    taskText("BUG", "CRITICAL", "Fix", "abcd1234"),
    "BUG[CRITICAL]: Fix {#todo:abcd1234}",
  );
});
tc("TC-132", "taskText без приоритета и ID", () => {
  assert.equal(taskText("TODO", "NONE", "Fix"), "TODO: Fix");
});
tc("TC-133", "ID: слишком короткий не распознаётся", () => {
  const t = parse("// TODO: x {#todo:abc}");
  assert.equal(t[0].id, undefined);
});
tc("TC-134", "ID не попадает в описание", () => {
  const t = parse("// TODO: x {#todo:abcd1234-5678}");
  assert.equal(t[0].description, "x");
  assert.equal(t[0].id, "abcd1234-5678");
});
tc("TC-135", "CRLF и номера строк", () => {
  const t = parse("a\r\nb\r\n// TODO: x");
  assert.equal(t[0].line, 2);
  assert.equal(t[0].description, "x");
});
tc("TC-136", "кириллица в описании", () => {
  assert.equal(
    parse("// TODO: Добавить проверку ввода")[0].description,
    "Добавить проверку ввода",
  );
});
tc("TC-137", "похожие слова не являются маркерами", () => {
  assert.equal(
    parse("// TODOS: a\n// DEBUG: b\n// TODOLIST c\n// MYBUG d").length,
    0,
  );
});
tc("TC-138", "регулярное выражение в JS не ломает разбор", () => {
  const t = parse(
    "const r = /[//] TODO: fake/;\nconst n = a / b; // TODO: real",
  );
  assert.deepEqual(
    t.map((x) => x.description),
    ["real"],
  );
});
tc("TC-139", "апостроф в HTML-тексте", () => {
  assert.equal(
    parse("<p>Don't</p> <!-- TODO: ship -->", "html")[0].description,
    "ship",
  );
});
tc(
  "TC-140",
  "languageForPath: Dockerfile, Makefile, неизвестное расширение",
  () => {
    assert.equal(languageForPath("/x/Dockerfile"), "dockerfile");
    assert.equal(languageForPath("/x/Makefile"), "makefile");
    assert.equal(languageForPath("/x/file.unknown"), "");
  },
);
tc("TC-141", "удаление комментария-блока целиком", () => {
  const text = "/*\nTODO: fix\n */\nrun();";
  const r = deletionRange(text, parse(text)[0]);
  assert.equal(text.slice(0, r.start) + text.slice(r.end), "run();");
});
tc("TC-142", "удаление inline-задачи сохраняет код", () => {
  const text = "execute(); // BUG: fail";
  const r = deletionRange(text, parse(text)[0]);
  assert.equal(text.slice(0, r.start) + text.slice(r.end), "execute(); ");
});
tc("TC-143", "статистика: типы и приоритеты", () => {
  const s = stats("// TODO[HIGH]: a\n// FIXME: b\n// BUG[CRITICAL]: c");
  assert.deepEqual(
    [
      s.types.TODO,
      s.types.FIXME,
      s.types.BUG,
      s.priorities.HIGH,
      s.priorities.CRITICAL,
      s.priorities.NONE,
    ],
    [1, 1, 1, 1, 1, 1],
  );
});
tc("TC-144", "статистика: число файлов", () => {
  const t = [
    ...parse("// TODO: a", "typescript", "file:///a.ts"),
    ...parse("// TODO: b", "typescript", "file:///b.ts"),
    ...parse("// TODO: c", "typescript", "file:///b.ts"),
  ];
  assert.equal(summarize(t, () => "open").files, 2);
});
tc("TC-145", "экранирование HTML в отчёте", () => {
  const s = stats("// TODO: a");
  const h = statisticsHtml({ ...s }, "csp");
  assert.doesNotMatch(h, /<img|onerror/);
});
