// Code.gs を、Apps Scriptのサービスを差し替えたNodeの中で動かして確かめる。
// 実Gmailには一切つながない。依存パッケージは使わない（node:test と node:vm だけ）。
//   node --test test/

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8')
  // テストから CONFIG を差し替えられるように、const を var にして文脈の持ち物にする。
  .replace('const CONFIG = Object.freeze({', 'var CONFIG = Object.freeze({');

// vm の中で作った配列は別の realm のものなので、比べる前にこちらの配列へ写す。
const plain = (value) => JSON.parse(JSON.stringify(value));

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-17T00:00:00Z'); // 東京で 2026-10-17 09:00
const MAILBOX = 'press@example.com';
const ALIAS = 'info@example.com';

const BASE_CONFIG = {
  labelName: '未対応',
  mailboxAddresses: [MAILBOX],
  recipients: ['a@example.com', 'b@example.com'],
  testRecipient: 'me@example.com',
  overdueDays: 5,
  triggerHour: 9,
  timeZone: 'Asia/Tokyo',
  senderName: '報道部・未対応メール通知',
  enabled: true,
  maxThreads: 500,
};

function message(from, daysAgo, extra = {}) {
  return {
    getFrom: () => from,
    getDate: () => new Date(NOW.getTime() - daysAgo * DAY),
    isDraft: () => Boolean(extra.draft),
    isInTrash: () => Boolean(extra.trash),
  };
}

function thread(id, subject, messages, extra = {}) {
  return {
    id,
    messages,
    getId: () => id,
    getFirstMessageSubject: () => subject,
    getPermalink: () => `https://mail.google.com/mail/#all/${id}`,
    isInTrash: () => Boolean(extra.trash),
    isInSpam: () => Boolean(extra.spam),
  };
}

function makeEnv({ threads = [], config = {}, labelExists = true, quota = 100,
  effectiveUser = MAILBOX, aliases = [ALIAS], failFor = [], lockFree = true } = {}) {
  const sent = [];
  const props = new Map();
  const triggers = [];
  const logs = [];
  const getThreadsCalls = [];

  const label = {
    getThreads(start, max) {
      getThreadsCalls.push([start, max]);
      return threads.slice(start, start + max);
    },
  };

  class FakeDate extends Date {
    constructor(...args) {
      if (args.length === 0) super(NOW.getTime());
      else super(...args);
    }
    static now() { return NOW.getTime(); }
  }

  const context = {
    Date: FakeDate,
    console: {
      log: (...a) => logs.push(a.join(' ')),
      warn: (...a) => logs.push(a.join(' ')),
    },
    GmailApp: {
      getUserLabelByName: (name) => (labelExists && name === '未対応' ? label : null),
      getAliases: () => aliases,
      getMessagesForThreads: (list) => list.map((t) => t.messages),
      sendEmail: (to, subject, body, options) => {
        if (failFor.includes(to)) throw new Error('Invalid email');
        sent.push({ to, subject, body, options });
      },
    },
    MailApp: { getRemainingDailyQuota: () => quota },
    Session: { getEffectiveUser: () => ({ getEmail: () => effectiveUser }) },
    LockService: {
      getScriptLock: () => ({ tryLock: () => lockFree, releaseLock: () => {} }),
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (props.has(k) ? props.get(k) : null),
        setProperty: (k, v) => props.set(k, v),
      }),
    },
    ScriptApp: {
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger: (t) => triggers.splice(triggers.indexOf(t), 1),
      newTrigger: (fn) => {
        const spec = { fn };
        const builder = {
          timeBased: () => builder,
          atHour: (h) => { spec.hour = h; return builder; },
          nearMinute: (m) => { spec.minute = m; return builder; },
          everyDays: (d) => { spec.days = d; return builder; },
          inTimezone: (tz) => { spec.tz = tz; return builder; },
          create: () => {
            const t = { spec, getHandlerFunction: () => fn };
            triggers.push(t);
            return t;
          },
        };
        return builder;
      },
    },
    Utilities: {
      formatDate(date, tz, pattern) {
        const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
          timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
        }).formatToParts(date).map((p) => [p.type, p.value]));
        return pattern
          .replace('yyyy', parts.year).replace('MM', parts.month).replace('dd', parts.day)
          .replace('HH', parts.hour).replace('mm', parts.minute);
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(SOURCE, context);
  context.CONFIG = Object.freeze({ ...BASE_CONFIG, ...config });
  return { context, sent, props, triggers, logs, getThreadsCalls };
}

const sampleThreads = () => [
  // 外部から6日前 → 対象
  thread('t1', '取材のお願い', [message('取材先 <Source@Example.org>', 6)]),
  // 外部から3日前 → 対象外
  thread('t2', '新しい問い合わせ', [message('x@example.org', 3)]),
  // 外部10日前、共有メールが1日前に返信 → 外部の10日前で判定（対象）
  thread('t3', '返信済みだが未完了', [
    message('y@example.org', 10),
    message(`報道部 <${MAILBOX}>`, 1),
  ]),
  // 別名から送っただけのスレッド（外部受信なし）→ 最後のメッセージ7日前で判定、印つき
  thread('t4', 'こちらから送った依頼', [message(`報道部 <${ALIAS}>`, 7)]),
  // 外部8日前、外部2日前に追撃 → 最新の外部2日前で対象外
  thread('t5', '追撃あり', [message('z@example.org', 8), message('z@example.org', 2)]),
  // ゴミ箱のスレッド → 数えない
  thread('t6', 'ゴミ箱', [message('w@example.org', 20)], { trash: true }),
  // 新しい外部メールが下書き・ゴミ箱 → それらは数えない（9日前で対象）
  thread('t7', '下書きあり', [
    message('v@example.org', 9),
    message('v@example.org', 1, { trash: true }),
    message(MAILBOX, 0, { draft: true }),
  ]),
];

test('抽出：外部受信の最新から5日以上のものだけ、古い順', () => {
  const { context } = makeEnv({ threads: sampleThreads() });
  const { items, truncated } = context.collectOverdue_(new Date(NOW.getTime()));
  assert.equal(truncated, false);
  assert.deepEqual(plain(items.map((i) => i.subject)),
    ['返信済みだが未完了', '下書きあり', 'こちらから送った依頼', '取材のお願い']);
  const t4 = items.find((i) => i.subject === 'こちらから送った依頼');
  assert.equal(t4.noInbound, true);
  assert.equal(items.find((i) => i.subject === '取材のお願い').overdueDays, 6);
  assert.equal(items.find((i) => i.subject === '返信済みだが未完了').from, 'y@example.org');
});

test('境界：ちょうど5×24時間は対象、1分足りなければ対象外', () => {
  const justOver = thread('a', 'ちょうど', [message('a@example.org', 5)]);
  const short = thread('b', '1分前', [message('b@example.org', 5 - 1 / 1440)]);
  const { context } = makeEnv({ threads: [justOver, short] });
  const { items } = context.collectOverdue_(new Date(NOW.getTime()));
  assert.deepEqual(plain(items.map((i) => i.subject)), ['ちょうど']);
});

test('ラベルが外れたスレッドは出てこない（ラベルの一覧に無いものは見ない）', () => {
  const env = makeEnv({ threads: sampleThreads() });
  env.context.notifyOverdueThreads();
  assert.ok(env.sent[0].body.includes('取材のお願い'));
  const next = makeEnv({ threads: sampleThreads().filter((t) => t.id !== 't1') });
  next.context.notifyOverdueThreads();
  assert.ok(!next.sent[0].body.includes('取材のお願い'));
});

test('本番：宛先ごとに個別送信し、件名と本文に必要事項が入る', () => {
  const { context, sent } = makeEnv({ threads: sampleThreads() });
  context.notifyOverdueThreads();
  assert.deepEqual(sent.map((s) => s.to), ['a@example.com', 'b@example.com']);
  const mail = sent[0];
  assert.equal(mail.subject, '[要対応・5日以上] 未対応メール 4件');
  assert.ok(mail.body.includes('受信日時: 2026/10/11 09:00'));
  assert.ok(mail.body.includes('経過: 6日'));
  assert.ok(mail.body.includes('https://mail.google.com/mail/#all/t1'));
  assert.equal(mail.options.name, '報道部・未対応メール通知');
});

test('0件なら送らない', () => {
  const { context, sent } = makeEnv({ threads: [thread('n', '新しい', [message('a@example.org', 1)])] });
  context.notifyOverdueThreads();
  assert.equal(sent.length, 0);
});

test('同じ日に2回動いても2通目は送らない。翌日はまた送る', () => {
  const env = makeEnv({ threads: sampleThreads() });
  env.context.notifyOverdueThreads();
  env.context.notifyOverdueThreads();
  assert.equal(env.sent.length, 2);
  const saved = JSON.parse(env.props.get('digestSentLog'));
  saved.date = '2026-10-16';
  env.props.set('digestSentLog', JSON.stringify(saved));
  env.context.notifyOverdueThreads();
  assert.equal(env.sent.length, 4);
});

test('途中で失敗したら残りは送り、再実行で失敗した人にだけ送る', () => {
  const env = makeEnv({ threads: sampleThreads(), failFor: ['a@example.com'] });
  assert.throws(() => env.context.notifyOverdueThreads(), /1件の送信に失敗/);
  assert.deepEqual(env.sent.map((s) => s.to), ['b@example.com']);
  env.context.GmailApp.sendEmail = (to, subject, body, options) => env.sent.push({ to, subject, body, options });
  env.context.notifyOverdueThreads();
  assert.deepEqual(env.sent.map((s) => s.to), ['b@example.com', 'a@example.com']);
});

test('宛先の重複（大文字小文字違い）は1通にまとめる', () => {
  const { context, sent } = makeEnv({
    threads: sampleThreads(),
    config: { recipients: ['a@example.com', 'A@Example.com'] },
  });
  context.notifyOverdueThreads();
  assert.deepEqual(sent.map((s) => s.to), ['a@example.com']);
});

test('送信上限が足りなければ1通も送らない', () => {
  const { context, sent } = makeEnv({ threads: sampleThreads(), quota: 1 });
  assert.throws(() => context.notifyOverdueThreads(), /送信上限/);
  assert.equal(sent.length, 0);
});

test('HTMLは件名・送信者をエスケープする', () => {
  const evil = thread('x', '<script>alert(1)</script> & "q"', [message('"Eve" <eve@example.org>', 9)]);
  const { context, sent } = makeEnv({ threads: [evil] });
  context.notifyOverdueThreads();
  const html = sent[0].options.htmlBody;
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;q&quot;'));
  assert.ok(html.includes('&quot;Eve&quot; &lt;eve@example.org&gt;'));
});

test('設定が未完了なら送らずに止まる', () => {
  for (const config of [
    { recipients: ['REPLACE_WITH_MEMBER_1@example.com'] },
    { mailboxAddresses: ['REPLACE_WITH_SHARED_MAILBOX@example.com'] },
    { mailboxAddresses: [] },
    { recipients: [] },
    { overdueDays: 0 },
    { triggerHour: 24 },
  ]) {
    const { context, sent } = makeEnv({ threads: sampleThreads(), config });
    assert.throws(() => context.notifyOverdueThreads(), /./, JSON.stringify(config));
    assert.equal(sent.length, 0);
  }
});

test('enabled が false なら本番もトリガー作成も断る', () => {
  const { context, sent, triggers } = makeEnv({ threads: sampleThreads(), config: { enabled: false } });
  assert.throws(() => context.notifyOverdueThreads(), /enabled/);
  assert.throws(() => context.installDailyTrigger(), /enabled/);
  assert.equal(sent.length, 0);
  assert.equal(triggers.length, 0);
});

test('ラベルが無ければ分かるエラーで止まる', () => {
  const { context, sent } = makeEnv({ labelExists: false });
  assert.throws(() => context.notifyOverdueThreads(), /ラベル「未対応」が見つかりません/);
  assert.equal(sent.length, 0);
});

test('共有アカウント以外で実行したら止まる', () => {
  const { context, sent } = makeEnv({ threads: sampleThreads(), effectiveUser: 'someone@example.net' });
  assert.throws(() => context.notifyOverdueThreads(), /共有アカウントで実行/);
  assert.equal(sent.length, 0);
});

test('ロックが取れなければ何もしない', () => {
  const { context, sent } = makeEnv({ threads: sampleThreads(), lockFree: false });
  context.notifyOverdueThreads();
  assert.equal(sent.length, 0);
});

test('プレビューは送らない', () => {
  const { context, sent } = makeEnv({ threads: sampleThreads() });
  const items = context.previewOverdueThreads();
  assert.equal(items.length, 4);
  assert.equal(sent.length, 0);
});

test('テスト送信は testRecipient だけ、0件ならダミー1件、送信記録に残さない', () => {
  const env = makeEnv({ threads: [] });
  env.context.sendTestNotification();
  assert.deepEqual(env.sent.map((s) => s.to), ['me@example.com']);
  assert.ok(env.sent[0].subject.startsWith('[テスト] '));
  assert.ok(env.sent[0].body.includes('表示確認用'));
  assert.equal(env.props.has('digestSentLog'), false);
});

test('トリガーは何度作っても1本、東京の9時', () => {
  const { context, triggers } = makeEnv();
  context.installDailyTrigger();
  context.installDailyTrigger();
  assert.equal(triggers.length, 1);
  assert.deepEqual(
    { ...triggers[0].spec },
    { fn: 'notifyOverdueThreads', hour: 9, minute: 0, days: 1, tz: 'Asia/Tokyo' },
  );
  context.removeDailyTrigger();
  assert.equal(triggers.length, 0);
});

test('ページング：100件ずつ読み、maxThreads を超えたら打ち切りを知らせる', () => {
  const many = Array.from({ length: 250 }, (_, i) => thread(`m${i}`, `件名${i}`, [message('a@example.org', 6)]));
  const env = makeEnv({ threads: many, config: { maxThreads: 200 } });
  const { items, truncated } = env.context.collectOverdue_(new Date(NOW.getTime()));
  assert.equal(items.length, 200);
  assert.equal(truncated, true);
  assert.deepEqual(env.getThreadsCalls.slice(0, 2), [[0, 100], [100, 100]]);
  env.context.notifyOverdueThreads();
  assert.ok(env.sent[0].body.includes('先頭200件までしか確認していません'));

  const all = makeEnv({ threads: many });
  const r = all.context.collectOverdue_(new Date(NOW.getTime()));
  assert.equal(r.items.length, 250);
  assert.equal(r.truncated, false);
});

test('アドレスの取り出し', () => {
  const { context } = makeEnv();
  assert.equal(context.extractAddress_('報道部 <Press@Example.com>'), 'press@example.com');
  assert.equal(context.extractAddress_('press@example.com'), 'press@example.com');
  assert.equal(context.extractAddress_('"a <b>" <c@example.com>'), 'c@example.com');
  assert.equal(context.extractAddress_(''), '');
});
