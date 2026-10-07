// ==UserScript==
// @name         Malgwi Panel
// @namespace    https://github.com/dhihm/malgwi
// @version      3.8
// @description  Malgwi study panel over one YouTube watch page: pronunciation, translation, explicit jump buttons, current-line highlight, and a drag-to-collect vocabulary book.
// @match        https://www.youtube.com/*
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==
"use strict";
/* The compiler injects the validated lesson document into this slot.
 * Playback stays on youtube.com through the normal page; this script only
 * augments the display and seeks the player locally in the user's browser.
 * All lesson text reaches the DOM through textContent only. */
var LESSON = /*__LESSON_JSON__*/null;
/* Single-lesson wrapper over the shared library panel code. */
var LESSONS = LESSON ? [LESSON] : null;

(function () {
  if (!Array.isArray(LESSONS) || LESSONS.length === 0) return;
  /* One panel per page: a second installed copy of this script (or an
   * older per-video build left installed) must not double-mount. */
  if (window.__yspPanelActive) return;
  window.__yspPanelActive = true;
  var VOCAB_KEY = "ysp:vocab:v1";
  /* Unicode-aware: Latin words, CJK sequences, or short phrases. */
  var WORD_SHAPE = /^[\p{L}\p{N}][\p{L}\p{N}'’-]*(?: [\p{L}\p{N}'’-]+){0,3}$/u;
  var CJK_ONLY = /^[\u1100-\u11FF\u3040-\u30FF\u3130-\u318F\u4E00-\u9FFF\uAC00-\uD7AF]+$/;

  /* Panel UI strings by study language; English is the fallback. */
  var STRINGS = {
    en: { panel: "Malgwi", vocab: "Vocabulary", pron: "Pronunciation", trans: "Translation",
          follow: "Follow", collapse: "Hide", help: "\u25B6 = jump \u00B7 drag a word = vocabulary \u00B7 drag header = move panel",
          empty: "Vocabulary is empty. Drag a word in the original text to add it.",
          dict: "Dictionary", dictTitle: "Open in a web dictionary", del: "Remove from vocabulary",
          jump: "Jump to this segment", repeat: "Repeat: once \u2192 loop \u2192 off", sentence: "Sentence repeat", speed: "Playback speed", opacity: "Panel opacity", resize: "Resize", add: "+ Vocab: " },
    ko: { panel: "말귀", vocab: "단어장", pron: "발음", trans: "번역",
          follow: "따라가기", collapse: "접기", help: "\u25B6 = 구간 점프 \u00B7 원문 드래그 = 단어장 \u00B7 헤더 드래그 = 패널 이동",
          empty: "단어장이 비어 있습니다. 원문에서 단어를 드래그해 추가하세요.",
          dict: "사전", dictTitle: "웹 사전에서 열기", del: "단어장에서 삭제",
          jump: "이 구간으로 이동", repeat: "반복: 1회 \u2192 계속 \u2192 해제", sentence: "문장 반복", speed: "재생 속도", opacity: "패널 투명도", resize: "크기 조절", add: "+ 단어장: " },
    zh: { panel: "Malgwi", vocab: "生词本", pron: "发音", trans: "翻译",
          follow: "跟随", collapse: "收起", help: "\u25B6 = 跳转 \u00B7 划选单词 = 生词本 \u00B7 拖动标题 = 移动面板",
          empty: "生词本是空的。在原文中划选单词即可添加。",
          dict: "词典", dictTitle: "在网络词典中打开", del: "从生词本删除",
          jump: "跳转到此片段", repeat: "循环: 一次 \u2192 持续 \u2192 关闭", sentence: "整句循环", speed: "播放速度", opacity: "面板透明度", resize: "调整大小", add: "+ 生词: " },
    ja: { panel: "Malgwi", vocab: "単語帳", pron: "発音", trans: "翻訳",
          follow: "追従", collapse: "閉じる", help: "\u25B6 = ジャンプ \u00B7 単語ドラッグ = 単語帳 \u00B7 ヘッダードラッグ = 移動",
          empty: "単語帳は空です。原文の単語をドラッグして追加してください。",
          dict: "辞書", dictTitle: "ウェブ辞書で開く", del: "単語帳から削除",
          jump: "この区間へ移動", repeat: "リピート: 1回 \u2192 連続 \u2192 解除", sentence: "文リピート", speed: "再生速度", opacity: "パネルの不透明度", resize: "サイズ変更", add: "+ 単語帳: " }
  };

  /* Panel chrome follows the user's system locale; lesson content
   * (pronunciation, translation, glossary) follows the study language. */
  function uiStrings() {
    var tag = "en";
    if (window.navigator && typeof window.navigator.language === "string") {
      tag = window.navigator.language.split("-")[0].toLowerCase();
    }
    return STRINGS[tag] || STRINGS.en;
  }

  /* Web dictionary by study language; Wiktionary is the fallback. */
  function dictionaryUrl(someLesson, word) {
    var study = someLesson && someLesson.study_language ? someLesson.study_language.split("-")[0] : "en";
    var source = someLesson && someLesson.video ? someLesson.video.source_language.split("-")[0] : "en";
    var query = encodeURIComponent(word);
    if (study === "ko") {
      return (source === "en" ? "https://en.dict.naver.com/#/search?query=" : "https://dict.naver.com/search.dict?query=") + query;
    }
    if (study === "zh") return "https://www.youdao.com/result?word=" + query + "&lang=" + source;
    if (study === "ja") return "https://ejje.weblio.jp/content/" + query;
    return "https://en.wiktionary.org/wiki/" + query;
  }
  var lesson = null;
  var panel = null;
  var listEl = null;
  var rows = [];
  var activeIndex = -1;
  var follow = true;
  var showPron = true;
  var showTrans = true;
  var collapsed = false;
  var vocabView = false;
  var timer = null;
  var addButton = null;
  /* Panel placement and opacity persist per browser. */
  var UI_KEY = "ysp:panel:v1";
  var OPACITIES = [1, 0.85, 0.65, 0.45];
  var panelLeft = null;
  var panelTop = null;
  var panelOpacity = 1;
  var dragging = null;
  var resizing = null;
  var panelWidth = null;
  var panelHeight = null;

  function loadUi() {
    try {
      var value = JSON.parse(window.localStorage.getItem(UI_KEY) || "{}");
      return value && typeof value === "object" ? value : {};
    } catch (error) {
      return {};
    }
  }

  function saveUi(patch) {
    try {
      var value = loadUi();
      for (var key in patch) value[key] = patch[key];
      window.localStorage.setItem(UI_KEY, JSON.stringify(value));
    } catch (error) {
      /* private mode etc.: placement just resets next session */
    }
  }

  function applyFloat(left, top) {
    if (!panel) return;
    var colors = palette();
    var maxLeft = (window.innerWidth || 1280) - 120;
    var maxTop = (window.innerHeight || 800) - 80;
    panelLeft = Math.min(Math.max(0, left), maxLeft);
    panelTop = Math.min(Math.max(0, top), maxTop);
    panel.style.left = panelLeft + "px";
    panel.style.top = panelTop + "px";
    panel.style.right = "auto";
    panel.style.bottom = "auto";
    panel.style.height = "70vh";
    panel.style.borderRadius = "10px";
    panel.style.border = "1px solid " + colors.border;
  }

  function applyOpacity(value) {
    panelOpacity = value;
    if (panel) panel.style.opacity = String(value);
  }

  function applySize(width, height) {
    if (!panel) return;
    var maxWidth = (window.innerWidth || 1280) - 40;
    var maxHeight = (window.innerHeight || 800) - 80;
    panelWidth = Math.min(Math.max(280, width), maxWidth);
    panelHeight = Math.min(Math.max(200, height), maxHeight);
    panel.style.width = panelWidth + "px";
    panel.style.maxWidth = "none";
    panel.style.height = panelHeight + "px";
    panel.style.bottom = "auto";
  }
  /* Repeat: 0 = off, 1 = repeat once, 2 = loop until turned off. The
   * repeated range is one cue, or the whole derived sentence around the
   * anchor cue when sentence mode is on (the default). */
  var repeatIndex = -1;
  var repeatStartIndex = -1;
  var repeatEndIndex = -1;
  var repeatMode = 0;
  var repeatArmed = false;
  var repeatButtons = [];
  var sentenceMode = true;

  function currentVideoId() {
    if (window.location.pathname !== "/watch") return null;
    return new URLSearchParams(window.location.search).get("v");
  }

  function lessonFor(videoId) {
    for (var i = 0; i < LESSONS.length; i += 1) {
      var candidate = LESSONS[i];
      if (candidate && candidate.video && candidate.video.video_id === videoId &&
          Array.isArray(candidate.lines) && candidate.lines.length > 0) {
        return candidate;
      }
    }
    return null;
  }

  function glossFor(someLesson, word) {
    if (!someLesson || !Array.isArray(someLesson.glossary)) return null;
    for (var i = 0; i < someLesson.glossary.length; i += 1) {
      if (someLesson.glossary[i].word === word) return someLesson.glossary[i].meaning;
    }
    return null;
  }

  function examplesFor(someLesson, word, limit) {
    var found = [];
    if (!someLesson) return found;
    var needle = word.toLowerCase();
    var cjk = CJK_ONLY.test(needle);
    for (var i = 0; i < someLesson.lines.length && found.length < limit; i += 1) {
      var original = someLesson.lines[i].original.toLowerCase();
      if (cjk) {
        /* CJK scripts have no word spaces: plain substring match. */
        if (original.indexOf(needle) !== -1) found.push(someLesson.lines[i]);
      } else {
        var haystack = " " + original.replace(/[^\p{L}\p{N}'’-]+/gu, " ") + " ";
        if (haystack.indexOf(" " + needle + " ") !== -1) found.push(someLesson.lines[i]);
      }
    }
    return found;
  }

  function normalizeWord(text) {
    var word = text
      .toLowerCase()
      .replace(/[‘’]/g, "'")
      .replace(/[^\p{L}\p{N}' -]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^['-]+|['-]+$/g, "");
    if (word.length === 0 || word.length > 40) return null;
    return WORD_SHAPE.test(word) ? word : null;
  }

  function loadVocab() {
    try {
      var parsed = JSON.parse(window.localStorage.getItem(VOCAB_KEY) || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      return [];
    }
  }

  function saveVocab(entries) {
    try {
      window.localStorage.setItem(VOCAB_KEY, JSON.stringify(entries));
    } catch (error) {
      /* private mode etc.: the in-memory panel still works this session */
    }
  }

  function addVocab(word, videoId) {
    var entries = loadVocab();
    for (var i = 0; i < entries.length; i += 1) {
      if (entries[i].word === word && entries[i].video_id === videoId) return false;
    }
    entries.push({ word: word, video_id: videoId, added_at: Date.now() });
    saveVocab(entries);
    return true;
  }

  function removeVocab(word, videoId) {
    saveVocab(loadVocab().filter(function (entry) {
      return !(entry.word === word && entry.video_id === videoId);
    }));
  }

  function videoElement() {
    return document.querySelector("#movie_player video") || document.querySelector("video");
  }

  function darkTheme() {
    return document.documentElement.hasAttribute("dark");
  }

  function formatTime(ms) {
    var total = Math.floor(ms / 1000);
    var m = Math.floor(total / 60);
    var s = total % 60;
    return m + ":" + (s < 10 ? "0" + s : s);
  }

  function palette() {
    return darkTheme()
      ? { bg: "#14161a", fg: "#e7e9ec", muted: "#9aa2ad", border: "#3a4048",
          activeBg: "#2c2712", activeEdge: "#d69e2e", pron: "#e0b458", trans: "#7ba7f7", chip: "#22262c" }
      : { bg: "#ffffff", fg: "#1a1d21", muted: "#6b7280", border: "#d1d5db",
          activeBg: "#fff7d6", activeEdge: "#f0b429", pron: "#7c5c10", trans: "#2563eb", chip: "#f3f4f6" };
  }

  function chipButton(label, pressed, onClick) {
    var colors = palette();
    var button = document.createElement("button");
    button.textContent = label;
    button.style.cssText =
      "font-size:12px;padding:3px 10px;border-radius:999px;cursor:pointer;border:1px solid " + colors.border + ";";
    function paint(on) {
      button.style.background = on ? colors.fg : colors.chip;
      button.style.color = on ? colors.bg : colors.fg;
    }
    paint(pressed());
    button.addEventListener("click", function () {
      onClick();
      paint(pressed());
    });
    return button;
  }

  function jumpButton(ms, label) {
    var colors = palette();
    var button = document.createElement("button");
    button.textContent = "▶ " + (label || formatTime(ms));
    button.title = uiStrings().jump;
    button.style.cssText =
      "font-size:11px;padding:2px 6px;border-radius:6px;cursor:pointer;white-space:nowrap;" +
      "border:1px solid " + colors.border + ";background:" + colors.chip + ";color:" + colors.fg + ";" +
      "font-variant-numeric:tabular-nums;height:fit-content;";
    button.addEventListener("click", function () {
      var video = videoElement();
      if (!video) return;
      /* An explicit jump is navigation: it always cancels the repeat,
       * so the repeat state cannot fight the user's seek. */
      clearRepeat();
      video.currentTime = ms / 1000;
      video.play();
    });
    return button;
  }

  /* Sentence grouping is derived at display time, never stored in the
   * originals. An explicit model-authored sentence_end flag wins; cues
   * without a flag fall back to sentence-final punctuation, speaker
   * changes, silence gaps, and a length cap. */
  var SENTENCE_END = /[.?!\u2026\u3002\uFF1F\uFF01]["'\u201D\u2019)\]\u00BB]*$/;

  function sentenceEndsAt(i) {
    var lines = lesson.lines;
    var line = lines[i];
    if (line.sentence_end === true) return true;
    if (line.sentence_end === false) return false;
    if (SENTENCE_END.test(line.original.trim())) return true;
    if (i + 1 < lines.length && lines[i + 1].original.trim().indexOf(">>") === 0) return true;
    if (i + 1 < lines.length && lines[i + 1].start_ms - lines[i].end_ms > 2500) return true;
    return false;
  }

  function sentenceRangeOf(index) {
    var lines = lesson.lines;
    var start = index;
    while (start > 0 && index - start < 11) {
      if (sentenceEndsAt(start - 1)) break;
      start -= 1;
    }
    var end = index;
    while (end < lines.length - 1 && end - start < 11) {
      if (sentenceEndsAt(end)) break;
      end += 1;
    }
    return [start, end];
  }

  function paintRepeat() {
    var colors = palette();
    for (var i = 0; i < repeatButtons.length; i += 1) {
      var button = repeatButtons[i];
      if (!button) continue;
      var active = i === repeatIndex && repeatMode > 0;
      button.textContent = active ? (repeatMode === 1 ? "↺1" : "↺∞") : "↺";
      button.style.background = active ? colors.activeBg : colors.chip;
      button.style.borderColor = active ? colors.activeEdge : colors.border;
    }
  }

  function clearRepeat() {
    repeatIndex = -1;
    repeatStartIndex = -1;
    repeatEndIndex = -1;
    repeatMode = 0;
    repeatArmed = false;
    paintRepeat();
  }

  function cycleRepeat(index) {
    var video = videoElement();
    if (index !== repeatIndex || repeatMode === 0) {
      var range = sentenceMode ? sentenceRangeOf(index) : [index, index];
      repeatIndex = index;
      repeatStartIndex = range[0];
      repeatEndIndex = range[1];
      repeatMode = 1;
      repeatArmed = false;
      if (video && lesson) {
        video.currentTime = lesson.lines[repeatStartIndex].start_ms / 1000;
        video.play();
      }
    } else if (repeatMode === 1) {
      repeatMode = 2;
    } else {
      clearRepeat();
      return;
    }
    paintRepeat();
  }

  function repeatButton(index) {
    var colors = palette();
    var button = document.createElement("button");
    button.textContent = "↺";
    button.title = uiStrings().repeat;
    button.style.cssText =
      "font-size:11px;padding:2px 6px;border-radius:6px;cursor:pointer;white-space:nowrap;margin-top:4px;" +
      "border:1px solid " + colors.border + ";background:" + colors.chip + ";color:" + colors.fg + ";" +
      "height:fit-content;";
    button.addEventListener("click", function () { cycleRepeat(index); });
    repeatButtons[index] = button;
    return button;
  }

  var SPEEDS = [1, 0.75, 0.5];

  function speedButton() {
    var colors = palette();
    var button = document.createElement("button");
    button.title = uiStrings().speed;
    button.style.cssText =
      "font-size:12px;padding:3px 10px;border-radius:999px;cursor:pointer;border:1px solid " + colors.border + ";";
    function paint() {
      var video = videoElement();
      var rate = video && video.playbackRate ? video.playbackRate : 1;
      button.textContent = rate + "\u00D7";
      button.style.background = rate !== 1 ? colors.fg : colors.chip;
      button.style.color = rate !== 1 ? colors.bg : colors.fg;
    }
    button.addEventListener("click", function () {
      var video = videoElement();
      if (!video) return;
      var current = SPEEDS.indexOf(video.playbackRate);
      video.playbackRate = SPEEDS[(current + 1) % SPEEDS.length] || 1;
      paint();
    });
    paint();
    return button;
  }

  function opacityButton() {
    var colors = palette();
    var button = document.createElement("button");
    button.title = uiStrings().opacity;
    button.style.cssText =
      "font-size:12px;padding:3px 10px;border-radius:999px;cursor:pointer;border:1px solid " + colors.border + ";";
    function paint() {
      button.textContent = Math.round(panelOpacity * 100) + "%";
      button.style.background = panelOpacity !== 1 ? colors.fg : colors.chip;
      button.style.color = panelOpacity !== 1 ? colors.bg : colors.fg;
    }
    button.addEventListener("click", function () {
      var current = OPACITIES.indexOf(panelOpacity);
      applyOpacity(OPACITIES[(current + 1) % OPACITIES.length] || 1);
      saveUi({ opacity: panelOpacity });
      paint();
    });
    paint();
    return button;
  }

  function setActive(index) {
    if (index === activeIndex) return;
    var colors = palette();
    if (activeIndex !== -1 && rows[activeIndex]) {
      rows[activeIndex].style.background = "transparent";
      rows[activeIndex].style.borderLeftColor = "transparent";
    }
    activeIndex = index;
    if (index === -1 || !rows[index]) return;
    rows[index].style.background = colors.activeBg;
    rows[index].style.borderLeftColor = colors.activeEdge;
    if (follow && listEl && !vocabView) {
      listEl.scrollTop = rows[index].offsetTop - listEl.clientHeight / 2 + rows[index].clientHeight / 2;
    }
  }

  /* Last line whose start has passed; -1 before the first line. */
  function lineAt(ms) {
    var low = 0;
    var high = lesson.lines.length - 1;
    var found = -1;
    while (low <= high) {
      var mid = (low + high) >> 1;
      if (lesson.lines[mid].start_ms <= ms) {
        found = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return found;
  }

  function tick() {
    var video = videoElement();
    if (!video || !lesson) return;
    var ms = video.currentTime * 1000;
    if (repeatMode > 0 && repeatStartIndex >= 0 && repeatEndIndex < lesson.lines.length) {
      var startMs = lesson.lines[repeatStartIndex].start_ms;
      var endMs = lesson.lines[repeatEndIndex].end_ms;
      if (ms < startMs - 3000 || ms > endMs + 3000) {
        /* Playback left the repeated range (manual seek, ad, navigation):
         * drop the repeat instead of pulling the user back. */
        clearRepeat();
      } else if (ms >= endMs) {
        if (repeatMode === 2) {
          video.currentTime = startMs / 1000;
          return;
        }
        if (!repeatArmed) {
          repeatArmed = true;
          video.currentTime = startMs / 1000;
          return;
        }
        clearRepeat();
      }
    }
    setActive(lineAt(ms));
  }

  function applyRowVisibility() {
    rows.forEach(function (row) {
      row.querySelector('[data-ysp="pron"]').style.display = showPron ? "block" : "none";
      row.querySelector('[data-ysp="trans"]').style.display = showTrans ? "block" : "none";
    });
  }

  function hideAddButton() {
    if (addButton) {
      addButton.remove();
      addButton = null;
    }
  }

  function showAddButton(x, y, word) {
    hideAddButton();
    var colors = palette();
    addButton = document.createElement("button");
    addButton.textContent = uiStrings().add + word;
    addButton.style.cssText =
      "position:fixed;left:" + Math.max(8, x - 40) + "px;top:" + Math.max(8, y - 38) + "px;z-index:7000;" +
      "font-size:12px;padding:4px 10px;border-radius:999px;cursor:pointer;" +
      "border:1px solid " + colors.activeEdge + ";background:" + colors.activeBg + ";color:" + colors.fg + ";" +
      "box-shadow:0 2px 8px rgba(0,0,0,0.25);";
    addButton.addEventListener("mousedown", function (event) {
      event.preventDefault();
      event.stopPropagation();
    });
    addButton.addEventListener("click", function () {
      addVocab(word, lesson.video.video_id);
      hideAddButton();
      if (vocabView) renderVocab();
    });
    document.body.appendChild(addButton);
  }

  function handleSelection(event) {
    window.setTimeout(function () {
      var selection = window.getSelection();
      if (!selection || selection.isCollapsed || !lesson) {
        hideAddButton();
        return;
      }
      var anchor = selection.anchorNode;
      if (!anchor || !listEl || !listEl.contains(anchor)) return;
      var word = normalizeWord(selection.toString());
      if (!word) {
        hideAddButton();
        return;
      }
      showAddButton(event.clientX, event.clientY, word);
    }, 0);
  }

  function renderLines() {
    var colors = palette();
    listEl.textContent = "";
    rows = [];
    activeIndex = -1;
    repeatButtons = [];
    clearRepeat();
    lesson.lines.forEach(function (line, index) {
      var row = document.createElement("div");
      row.style.cssText =
        "display:grid;grid-template-columns:58px 1fr;gap:8px;padding:6px 8px;border-radius:8px;" +
        "border-left:3px solid transparent;";
      var side = document.createElement("div");
      side.style.cssText = "display:flex;flex-direction:column;align-items:flex-start;";
      side.appendChild(jumpButton(line.start_ms));
      side.appendChild(repeatButton(index));
      var body = document.createElement("div");
      var original = document.createElement("div");
      original.textContent = line.original;
      original.style.cssText = "font-size:13px;font-weight:600;cursor:text;";
      var pron = document.createElement("div");
      pron.setAttribute("data-ysp", "pron");
      pron.textContent = line.pronunciation;
      pron.style.cssText = "color:" + colors.pron + ";font-size:12px;";
      var trans = document.createElement("div");
      trans.setAttribute("data-ysp", "trans");
      trans.textContent = line.translation;
      trans.style.cssText = "color:" + colors.trans + ";font-size:12px;";
      body.appendChild(original);
      body.appendChild(pron);
      body.appendChild(trans);
      row.appendChild(side);
      row.appendChild(body);
      listEl.appendChild(row);
      rows.push(row);
    });
    applyRowVisibility();
  }

  function renderVocab() {
    var colors = palette();
    listEl.textContent = "";
    rows = [];
    activeIndex = -1;
    var entries = loadVocab();
    if (entries.length === 0) {
      var empty = document.createElement("div");
      empty.textContent = uiStrings().empty;
      empty.style.cssText = "color:" + colors.muted + ";font-size:12px;padding:12px 8px;";
      listEl.appendChild(empty);
      return;
    }
    entries.sort(function (a, b) { return (b.added_at || 0) - (a.added_at || 0); });
    entries.forEach(function (entry) {
      var sourceLesson = lessonFor(entry.video_id);
      var card = document.createElement("div");
      card.style.cssText =
        "padding:8px;border:1px solid " + colors.border + ";border-radius:8px;margin-bottom:8px;";
      var head = document.createElement("div");
      head.style.cssText = "display:flex;gap:8px;align-items:baseline;";
      var word = document.createElement("div");
      word.textContent = entry.word;
      word.style.cssText = "font-size:14px;font-weight:700;";
      var meaning = document.createElement("div");
      var gloss = glossFor(sourceLesson, entry.word);
      meaning.textContent = gloss || "";
      meaning.style.cssText = "font-size:13px;color:" + colors.trans + ";margin-right:auto;";
      var text = uiStrings();
      var dict = document.createElement("button");
      dict.textContent = text.dict;
      dict.title = text.dictTitle;
      dict.style.cssText =
        "font-size:11px;padding:2px 8px;border-radius:6px;cursor:pointer;border:1px solid " + colors.border + ";" +
        "background:" + colors.chip + ";color:" + colors.fg + ";";
      dict.addEventListener("click", function () {
        /* One named dictionary tab is reused across lookups. */
        window.open(dictionaryUrl(sourceLesson || lesson, entry.word), "ysp-dictionary");
      });
      var del = document.createElement("button");
      del.textContent = "×";
      del.title = text.del;
      del.style.cssText =
        "font-size:13px;padding:0 7px;border-radius:6px;cursor:pointer;border:1px solid " + colors.border + ";" +
        "background:" + colors.chip + ";color:" + colors.muted + ";";
      del.addEventListener("click", function () {
        removeVocab(entry.word, entry.video_id);
        renderVocab();
      });
      head.appendChild(word);
      head.appendChild(meaning);
      head.appendChild(dict);
      head.appendChild(del);
      card.appendChild(head);

      examplesFor(sourceLesson, entry.word, 2).forEach(function (line) {
        var example = document.createElement("div");
        example.style.cssText = "display:grid;grid-template-columns:58px 1fr;gap:8px;margin-top:6px;";
        var side = document.createElement("div");
        if (lesson && sourceLesson === lesson) {
          side.appendChild(jumpButton(line.start_ms));
        } else {
          var when = document.createElement("div");
          when.textContent = formatTime(line.start_ms);
          when.style.cssText = "color:" + colors.muted + ";font-size:11px;";
          side.appendChild(when);
        }
        var body = document.createElement("div");
        var original = document.createElement("div");
        original.textContent = line.original;
        original.style.cssText = "font-size:12px;font-weight:600;";
        var trans = document.createElement("div");
        trans.textContent = line.translation;
        trans.style.cssText = "font-size:12px;color:" + colors.trans + ";";
        body.appendChild(original);
        body.appendChild(trans);
        example.appendChild(side);
        example.appendChild(body);
        card.appendChild(example);
      });
      listEl.appendChild(card);
    });
  }

  function renderList() {
    if (vocabView) renderVocab();
    else renderLines();
  }

  function buildPanel() {
    var colors = palette();
    panel = document.createElement("div");
    panel.id = "ysp-panel";
    panel.style.cssText =
      "position:fixed;top:60px;right:0;bottom:0;width:400px;max-width:90vw;z-index:6000;" +
      "display:flex;flex-direction:column;background:" + colors.bg + ";color:" + colors.fg + ";" +
      "border-left:1px solid " + colors.border + ";font-family:'Pretendard','Apple SD Gothic Neo','Noto Sans KR',system-ui,sans-serif;" +
      "box-shadow:-4px 0 16px rgba(0,0,0,0.15);overflow:hidden;";

    var header = document.createElement("div");
    header.style.cssText =
      "display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:10px 12px;border-bottom:1px solid " + colors.border + ";" +
      "cursor:move;user-select:none;";
    var text = uiStrings();
    var title = document.createElement("div");
    title.textContent = text.panel;
    title.style.cssText = "font-weight:700;font-size:14px;margin-right:auto;";
    header.appendChild(title);
    header.appendChild(chipButton(text.pron, function () { return showPron; }, function () {
      showPron = !showPron;
      applyRowVisibility();
    }));
    header.appendChild(chipButton(text.trans, function () { return showTrans; }, function () {
      showTrans = !showTrans;
      applyRowVisibility();
    }));
    header.appendChild(chipButton(text.follow, function () { return follow; }, function () { follow = !follow; }));
    header.appendChild(chipButton(text.sentence, function () { return sentenceMode; }, function () {
      sentenceMode = !sentenceMode;
      clearRepeat();
    }));
    header.appendChild(speedButton());
    header.appendChild(opacityButton());
    header.addEventListener("mousedown", function (event) {
      /* Drag by the header background or title, never by its buttons. */
      if (event.target !== header && event.target !== title) return;
      var baseLeft = panelLeft !== null ? panelLeft : (window.innerWidth || 1280) - 400;
      var baseTop = panelTop !== null ? panelTop : 60;
      dragging = { x: event.clientX, y: event.clientY, left: baseLeft, top: baseTop };
    });
    header.appendChild(chipButton(text.vocab, function () { return vocabView; }, function () {
      vocabView = !vocabView;
      title.textContent = vocabView ? text.panel + " · " + text.vocab : text.panel;
      renderList();
    }));
    header.appendChild(chipButton(text.collapse, function () { return false; }, function () { setCollapsed(true); }));
    panel.appendChild(header);

    var help = document.createElement("div");
    help.textContent = text.help;
    help.style.cssText = "font-size:11px;color:" + colors.muted + ";padding:6px 12px 0;";
    panel.appendChild(help);

    listEl = document.createElement("div");
    listEl.style.cssText = "overflow-y:auto;flex:1;padding:8px 10px 24px;";
    listEl.addEventListener("mouseup", handleSelection);
    listEl.addEventListener("scroll", hideAddButton);
    panel.appendChild(listEl);

    /* Custom resize grip: a native CSS resizer gets buried under the
     * scrolling list, so drag this corner instead. */
    var grip = document.createElement("div");
    grip.id = "ysp-grip";
    grip.textContent = "◢";
    grip.title = uiStrings().resize;
    grip.style.cssText =
      "position:absolute;right:0;bottom:0;width:20px;height:20px;z-index:6001;" +
      "display:flex;align-items:flex-end;justify-content:flex-end;padding:0 3px 1px 0;" +
      "cursor:nwse-resize;color:" + colors.muted + ";font-size:11px;user-select:none;";
    grip.addEventListener("mousedown", function (event) {
      if (panelLeft === null) {
        /* Undock first so left/top stay put while the size changes. */
        applyFloat((window.innerWidth || 1280) - (panelWidth || 400), 60);
      }
      resizing = {
        x: event.clientX,
        y: event.clientY,
        width: panelWidth || 400,
        height: panelHeight || (window.innerHeight || 800) - 140,
      };
    });
    panel.appendChild(grip);
    document.body.appendChild(panel);
    var ui = loadUi();
    if (typeof ui.opacity === "number" && OPACITIES.indexOf(ui.opacity) !== -1) applyOpacity(ui.opacity);
    else applyOpacity(1);
    if (typeof ui.left === "number" && typeof ui.top === "number") applyFloat(ui.left, ui.top);
    if (typeof ui.width === "number" && typeof ui.height === "number") applySize(ui.width, ui.height);
    document.addEventListener("mousedown", function (event) {
      if (addButton && event.target !== addButton) hideAddButton();
    });
    document.addEventListener("mousemove", function (event) {
      if (dragging) {
        applyFloat(dragging.left + (event.clientX - dragging.x), dragging.top + (event.clientY - dragging.y));
      } else if (resizing) {
        applySize(resizing.width + (event.clientX - resizing.x), resizing.height + (event.clientY - resizing.y));
      }
    });
    document.addEventListener("mouseup", function () {
      if (dragging) {
        dragging = null;
        saveUi({ left: panelLeft, top: panelTop });
      }
      if (resizing) {
        resizing = null;
        saveUi({ width: panelWidth, height: panelHeight });
      }
    });
    renderList();

    var tab = document.createElement("button");
    tab.id = "ysp-tab";
    tab.textContent = text.panel;
    tab.style.cssText =
      "position:fixed;top:50%;right:0;z-index:6000;display:none;cursor:pointer;" +
      "writing-mode:vertical-rl;padding:12px 6px;border-radius:8px 0 0 8px;border:1px solid " + colors.border + ";" +
      "border-right:none;background:" + colors.bg + ";color:" + colors.fg + ";font-size:12px;";
    tab.addEventListener("click", function () { setCollapsed(false); });
    document.body.appendChild(tab);
  }

  function setCollapsed(next) {
    collapsed = next;
    if (!panel) return;
    panel.style.display = collapsed ? "none" : "flex";
    var tab = document.getElementById("ysp-tab");
    if (tab) tab.style.display = collapsed ? "block" : "none";
  }

  function mount(next) {
    if (panel && lesson === next) return;
    unmount();
    lesson = next;
    buildPanel();
    timer = window.setInterval(tick, 200);
    if (collapsed) setCollapsed(true);
  }

  function unmount() {
    if (timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
    resizing = null;
    hideAddButton();
    if (panel) {
      panel.remove();
      panel = null;
    }
    var tab = document.getElementById("ysp-tab");
    if (tab) tab.remove();
    rows = [];
    activeIndex = -1;
    repeatButtons = [];
    repeatIndex = -1;
    repeatStartIndex = -1;
    repeatEndIndex = -1;
    repeatMode = 0;
    repeatArmed = false;
    lesson = null;
  }

  function check() {
    var next = lessonFor(currentVideoId());
    if (next) {
      mount(next);
    } else {
      unmount();
    }
  }

  /* YouTube is a SPA: react to its navigation event, with a slow fallback. */
  window.addEventListener("yt-navigate-finish", function () { window.setTimeout(check, 300); });
  window.setInterval(check, 2000);
  check();
})();
