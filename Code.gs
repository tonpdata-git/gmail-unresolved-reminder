/**
 * 「未対応」ラベルが付いたまま一定日数が経過したGmailスレッドを、
 * 報道部員へ日次メールで通知するGoogle Apps Script。
 *
 * 導入前に CONFIG の REPLACE_WITH_* をすべて実値へ置き換え、
 * テストが終わってから enabled を true にしてください。
 * パスワード・OAuthトークン・APIキーは使いません（権限はApps Scriptの承認画面で与えます）。
 *
 * 実アドレスを入れるのは、Apps Scriptへ貼り付けた後のコードだけにしてください。
 * このファイルを公開リポジトリへ戻すときは、必ずプレースホルダーのままにします。
 *
 * 制作: 小宮正希（東北大学学友会報道部 / GitHub: komiyamasakir7-max）
 * https://github.com/tonpdata-git/gmail-unresolved-reminder
 */

const CONFIG = Object.freeze({
  // Gmail上のラベル名（大文字・小文字、全角・半角を含め完全一致）
  labelName: '未対応',

  // 報道部共有メールのアドレスと、送信に使う別名（alias）。
  // これらから送ったメールは「外部からの受信」として数えない。
  // 実行アカウント自身とGmailの「送信元」に登録済みの別名は、自動でも除外する。
  mailboxAddresses: [
    'REPLACE_WITH_SHARED_MAILBOX@example.com',
  ],

  // 通知先。各人へ個別に送るので、宛先同士にアドレスは見えない。
  recipients: [
    'REPLACE_WITH_MEMBER_1@example.com',
    'REPLACE_WITH_MEMBER_2@example.com',
  ],

  // テストメールだけを受け取るアドレス。
  testRecipient: 'REPLACE_WITH_YOUR_ADDRESS@example.com',

  overdueDays: 5,
  triggerHour: 9,
  timeZone: 'Asia/Tokyo',
  senderName: '報道部・未対応メール通知',

  // 設定とテストが終わるまで false のままにする。
  enabled: false,

  // 誤設定時の大量処理を防ぐ安全上限。超えた分は通知本文にその旨を書く。
  maxThreads: 500,
});

const DAY_MS = 24 * 60 * 60 * 1000;
const TRIGGER_FUNCTION = 'notifyOverdueThreads';
const PAGE_SIZE = 100;
const LOCK_WAIT_MS = 30 * 1000;
const SENT_LOG_KEY = 'digestSentLog';

// ---------------------------------------------------------------------------
// 利用者が実行する関数
// ---------------------------------------------------------------------------

/**
 * 本番用。時間主導トリガーからもこの関数を呼ぶ。
 * 対象が0件ならメールを送らない。同じ日に2回動いても、送り済みの人には送らない。
 */
function notifyOverdueThreads() {
  validateConfig_({ requireRecipients: true });
  if (!CONFIG.enabled) {
    throw new Error('CONFIG.enabled が false です。テストが終わってから true にしてください。');
  }
  assertRunningAsMailbox_();

  withLock_(() => {
    const now = new Date();
    const result = collectOverdue_(now);
    if (result.items.length === 0) {
      console.log(`${CONFIG.overdueDays}日以上経過した未対応メールはありません。通知は送りません。`);
      return;
    }
    const sent = sendDigest_(CONFIG.recipients, result, { isTest: false, now });
    console.log(`${sent}人へ、${result.items.length}件の通知を送信しました。`);
  });
}

/**
 * Gmailへ送信せず、現在の対象を実行ログへ出す。
 * 最初にこの関数を実行して抽出条件を確認する。
 */
function previewOverdueThreads() {
  validateConfig_({ requireRecipients: false });
  const result = collectOverdue_(new Date());
  console.log(`対象 ${result.items.length}件${result.truncated ? '（上限で打ち切り。ほかにもあります）' : ''}`);
  result.items.forEach((item, index) => {
    console.log([
      `${index + 1}. ${item.subject}`,
      `   送信者: ${item.from}`,
      `   基準日時: ${formatDate_(item.receivedAt)}${item.noInbound ? '（外部からの受信なし。最後のメッセージで判定）' : ''}`,
      `   経過: ${item.overdueDays}日`,
      `   ${item.permalink}`,
    ].join('\n'));
  });
  return result.items;
}

/**
 * CONFIG.testRecipient にだけテストメールを1通送る。
 * 対象が0件の場合は、表示確認用のダミー1件を入れる。送信記録には残さない。
 */
function sendTestNotification() {
  validateConfig_({ requireRecipients: false });
  validateAddress_(CONFIG.testRecipient, 'testRecipient');

  withLock_(() => {
    const now = new Date();
    const result = collectOverdue_(now);
    if (result.items.length === 0) {
      result.items = [{
        subject: '（表示確認用）未対応メールの例',
        from: '送信者名 <sender@example.com>',
        receivedAt: new Date(now.getTime() - CONFIG.overdueDays * DAY_MS),
        overdueDays: CONFIG.overdueDays,
        noInbound: false,
        permalink: 'https://mail.google.com/',
      }];
    }
    sendDigest_([CONFIG.testRecipient], result, { isTest: true, now });
    console.log(`テストメールを ${CONFIG.testRecipient} へ送信しました。`);
  });
}

/**
 * 毎日実行するトリガーを作り直す（既存の同じトリガーは先に消すので、何度実行しても1本だけ）。
 * Apps Scriptの仕様上、実行時刻は指定した時の中で前後する。
 */
function installDailyTrigger() {
  validateConfig_({ requireRecipients: true });
  if (!CONFIG.enabled) {
    throw new Error('CONFIG.enabled を true にしてからトリガーを作成してください。');
  }
  assertRunningAsMailbox_();

  const removed = removeDailyTrigger();
  ScriptApp.newTrigger(TRIGGER_FUNCTION)
    .timeBased()
    .atHour(CONFIG.triggerHour)
    .nearMinute(0)
    .everyDays(1)
    .inTimezone(CONFIG.timeZone)
    .create();

  console.log(`毎日${CONFIG.triggerHour}時ごろ（${CONFIG.timeZone}）のトリガーを作成しました。`
    + (removed > 0 ? `（古いトリガー${removed}本は削除済み）` : ''));
}

/** 通知用トリガーを削除する。削除した本数を返す。 */
function removeDailyTrigger() {
  const triggers = ScriptApp.getProjectTriggers()
    .filter((trigger) => trigger.getHandlerFunction() === TRIGGER_FUNCTION);
  triggers.forEach((trigger) => ScriptApp.deleteTrigger(trigger));
  console.log(`通知用トリガーを${triggers.length}本削除しました。`);
  return triggers.length;
}

// ---------------------------------------------------------------------------
// 抽出
// ---------------------------------------------------------------------------

/**
 * ラベル付きスレッドのうち、基準日時から overdueDays×24時間以上たったものを返す。
 * 返り値: { items: [...], truncated: boolean }
 */
function collectOverdue_(now) {
  const label = GmailApp.getUserLabelByName(CONFIG.labelName);
  if (!label) {
    throw new Error(`Gmailラベル「${CONFIG.labelName}」が見つかりません。ラベル名を完全一致で確認してください。`);
  }

  const ownAddresses = getOwnAddresses_();
  const cutoff = now.getTime() - CONFIG.overdueDays * DAY_MS;
  const items = [];
  let scanned = 0;
  let truncated = false;

  while (scanned < CONFIG.maxThreads) {
    const size = Math.min(PAGE_SIZE, CONFIG.maxThreads - scanned);
    const page = label.getThreads(scanned, size);
    if (page.length === 0) break;
    scanned += page.length;

    const threads = page.filter((thread) => !thread.isInTrash() && !thread.isInSpam());
    const messagesByThread = threads.length > 0 ? GmailApp.getMessagesForThreads(threads) : [];

    threads.forEach((thread, index) => {
      const reference = pickReferenceMessage_(messagesByThread[index], ownAddresses);
      if (!reference) return;
      const receivedAt = reference.message.getDate();
      if (receivedAt.getTime() > cutoff) return;

      items.push({
        subject: thread.getFirstMessageSubject() || '（件名なし）',
        from: reference.message.getFrom() || '（送信者不明）',
        receivedAt,
        overdueDays: Math.floor((now.getTime() - receivedAt.getTime()) / DAY_MS),
        noInbound: reference.noInbound,
        permalink: thread.getPermalink(),
      });
    });

    if (page.length < size) break;
  }

  if (scanned >= CONFIG.maxThreads && label.getThreads(scanned, 1).length > 0) {
    truncated = true;
    console.warn(`「${CONFIG.labelName}」のスレッドが maxThreads（${CONFIG.maxThreads}）を超えています。超えた分は確認していません。`);
  }

  items.sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
  return { items, truncated };
}

/**
 * 判定の基準にするメッセージを選ぶ。
 * 下書き・ゴミ箱のメッセージは数えない。外部からの受信があればその最新を、
 * 無ければ（自分たちの送信だけのスレッド）最後のメッセージを、noInbound 付きで返す。
 */
function pickReferenceMessage_(messages, ownAddresses) {
  const usable = (messages || [])
    .filter((message) => !message.isDraft() && !message.isInTrash())
    .sort((a, b) => a.getDate().getTime() - b.getDate().getTime());
  if (usable.length === 0) return null;

  const inbound = usable.filter((message) => !ownAddresses.has(extractAddress_(message.getFrom())));
  if (inbound.length > 0) return { message: inbound[inbound.length - 1], noInbound: false };
  return { message: usable[usable.length - 1], noInbound: true };
}

/** 共有メール自身として扱うアドレスの集合（小文字）。 */
function getOwnAddresses_() {
  const own = new Set(CONFIG.mailboxAddresses.map(normalizeAddress_));
  const effective = getEffectiveUserEmail_();
  if (effective) own.add(effective);
  GmailApp.getAliases().forEach((alias) => own.add(normalizeAddress_(alias)));
  return own;
}

// ---------------------------------------------------------------------------
// 送信
// ---------------------------------------------------------------------------

/**
 * 各宛先へ個別に送る。本番では、その日すでに送った人には送らない
 * （トリガーの重複や手動実行で同じ日に2通届くのを防ぎ、途中で失敗したときは残りだけ送り直せる）。
 * 送った人数を返す。
 */
function sendDigest_(recipients, result, options) {
  const unique = dedupeAddresses_(recipients);
  const today = Utilities.formatDate(options.now, CONFIG.timeZone, 'yyyy-MM-dd');
  const props = PropertiesService.getScriptProperties();
  const log = options.isTest ? null : readSentLog_(props, today);
  const pending = log ? unique.filter((address) => !log.recipients.includes(address)) : unique;

  if (pending.length === 0) {
    console.log(`本日（${today}）の通知は全員に送信済みです。`);
    return 0;
  }

  const quota = MailApp.getRemainingDailyQuota();
  if (quota < pending.length) {
    throw new Error(`本日の送信上限が足りません（残り${quota}通、必要${pending.length}通）。1通も送っていません。`);
  }

  const prefix = options.isTest ? '[テスト] ' : '';
  const subject = `${prefix}[要対応・${CONFIG.overdueDays}日以上] 未対応メール ${result.items.length}件`;
  const plainBody = buildPlainBody_(result, options.isTest);
  const htmlBody = buildHtmlBody_(result, options.isTest);

  const failures = [];
  let sent = 0;
  pending.forEach((recipient) => {
    try {
      GmailApp.sendEmail(recipient, subject, plainBody, { htmlBody, name: CONFIG.senderName });
      sent += 1;
      if (log) {
        log.recipients.push(recipient);
        props.setProperty(SENT_LOG_KEY, JSON.stringify(log));
      }
    } catch (error) {
      failures.push(`${recipient}: ${error && error.message ? error.message : error}`);
    }
  });

  if (failures.length > 0) {
    throw new Error(`${failures.length}件の送信に失敗しました（成功${sent}件）。もう一度実行すると失敗した人にだけ送ります。\n${failures.join('\n')}`);
  }
  return sent;
}

function readSentLog_(props, today) {
  try {
    const saved = JSON.parse(props.getProperty(SENT_LOG_KEY) || 'null');
    if (saved && saved.date === today && Array.isArray(saved.recipients)) return saved;
  } catch (error) {
    console.warn('送信記録が読めなかったため、作り直します。');
  }
  return { date: today, recipients: [] };
}

function buildPlainBody_(result, isTest) {
  const lines = [];
  if (isTest) lines.push('これは設定確認用のテストメールです。', '');
  lines.push(
    `「${CONFIG.labelName}」ラベルが付いたまま、最新の受信から${CONFIG.overdueDays}日以上経過したメールがあります。`,
    '担当者に限らず、確認した人が対応状況を確認してください。',
    ''
  );

  result.items.forEach((item, index) => {
    lines.push(
      `${index + 1}. ${item.subject}`,
      `送信者: ${item.from}`,
      `受信日時: ${formatDate_(item.receivedAt)}${item.noInbound ? '（外部からの受信なし。最後のメッセージの日時）' : ''}`,
      `経過: ${item.overdueDays}日`,
      `開く: ${item.permalink}`,
      ''
    );
  });

  if (result.truncated) {
    lines.push(`※ 対象のスレッドが多いため、先頭${CONFIG.maxThreads}件までしか確認していません。`, '');
  }
  lines.push(
    `対応後はGmailの「${CONFIG.labelName}」ラベルを外してください。`,
    'リンクは報道部の共有アカウントでGmailにログインしているときに開けます。'
  );
  return lines.join('\n');
}

function buildHtmlBody_(result, isTest) {
  const cell = 'padding:8px;border:1px solid #ddd;vertical-align:top';
  const testNotice = isTest
    ? '<p style="color:#b45309"><strong>これは設定確認用のテストメールです。</strong></p>'
    : '';
  const truncatedNotice = result.truncated
    ? `<p>※ 対象のスレッドが多いため、先頭${CONFIG.maxThreads}件までしか確認していません。</p>`
    : '';

  const rows = result.items.map((item, index) => `
    <tr>
      <td style="${cell}">${index + 1}</td>
      <td style="${cell}"><a href="${escapeHtml_(item.permalink)}">${escapeHtml_(item.subject)}</a></td>
      <td style="${cell}">${escapeHtml_(item.from)}</td>
      <td style="${cell}">${escapeHtml_(formatDate_(item.receivedAt))}${item.noInbound ? '<br><small>外部からの受信なし</small>' : ''}</td>
      <td style="${cell};text-align:right">${item.overdueDays}日</td>
    </tr>`).join('');

  return `
    ${testNotice}
    <p>「${escapeHtml_(CONFIG.labelName)}」ラベルが付いたまま、最新の受信から
      ${CONFIG.overdueDays}日以上経過したメールがあります。</p>
    <p><strong>担当者に限らず、確認した人が対応状況を確認してください。</strong></p>
    <table style="border-collapse:collapse">
      <thead>
        <tr>
          <th style="${cell}">#</th>
          <th style="${cell}">件名</th>
          <th style="${cell}">送信者</th>
          <th style="${cell}">受信日時</th>
          <th style="${cell}">経過</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    ${truncatedNotice}
    <p>対応後はGmailの「${escapeHtml_(CONFIG.labelName)}」ラベルを外してください。<br>
      <small>リンクは報道部の共有アカウントでGmailにログインしているときに開けます。</small></p>`;
}

// ---------------------------------------------------------------------------
// 検査と小道具
// ---------------------------------------------------------------------------

function validateConfig_(options) {
  if (typeof CONFIG.labelName !== 'string' || !CONFIG.labelName.trim()) {
    throw new Error('labelName を設定してください。');
  }
  if (!Number.isInteger(CONFIG.overdueDays) || CONFIG.overdueDays < 1) {
    throw new Error('overdueDays は1以上の整数にしてください。');
  }
  if (!Number.isInteger(CONFIG.triggerHour) || CONFIG.triggerHour < 0 || CONFIG.triggerHour > 23) {
    throw new Error('triggerHour は0〜23の整数にしてください。');
  }
  if (!Number.isInteger(CONFIG.maxThreads) || CONFIG.maxThreads < 1) {
    throw new Error('maxThreads は1以上の整数にしてください。');
  }
  if (!Array.isArray(CONFIG.mailboxAddresses) || CONFIG.mailboxAddresses.length === 0) {
    throw new Error('mailboxAddresses に共有メールのアドレスを1件以上設定してください。');
  }
  CONFIG.mailboxAddresses.forEach((address, index) => {
    validateAddress_(address, `mailboxAddresses[${index}]`);
  });

  if (options.requireRecipients) {
    if (!Array.isArray(CONFIG.recipients) || CONFIG.recipients.length === 0) {
      throw new Error('recipients を1件以上設定してください。');
    }
    CONFIG.recipients.forEach((address, index) => {
      validateAddress_(address, `recipients[${index}]`);
    });
  }
}

/**
 * 個人のアカウントでトリガーを作ってしまう事故を防ぐ。
 * 実行アカウントのアドレスが取れたときだけ、mailboxAddresses に含まれるかを確かめる。
 */
function assertRunningAsMailbox_() {
  const effective = getEffectiveUserEmail_();
  if (!effective) return;
  const mailboxes = CONFIG.mailboxAddresses.map(normalizeAddress_);
  if (!mailboxes.includes(effective)) {
    throw new Error(`このスクリプトを実行しているアカウント（${effective}）が mailboxAddresses にありません。報道部の共有アカウントで実行してください。`);
  }
}

function getEffectiveUserEmail_() {
  try {
    return normalizeAddress_(Session.getEffectiveUser().getEmail());
  } catch (error) {
    return '';
  }
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) {
    console.log('別の処理が実行中のため、今回は何もせず終了しました。');
    return;
  }
  try {
    fn();
  } finally {
    lock.releaseLock();
  }
}

function validateAddress_(address, fieldName) {
  if (!isUsableAddress_(address)) {
    throw new Error(`${fieldName} に実際のメールアドレスを設定してください（REPLACE_WITH_ のままか、形式が正しくありません）。`);
  }
}

function isUsableAddress_(address) {
  return typeof address === 'string'
    && !address.includes('REPLACE_WITH_')
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address.trim());
}

function normalizeAddress_(address) {
  return String(address || '').trim().toLowerCase();
}

function dedupeAddresses_(addresses) {
  return Array.from(new Set(addresses.map(normalizeAddress_)));
}

/** "名前 <a@example.com>" や "a@example.com" からアドレスだけを小文字で取り出す。 */
function extractAddress_(headerValue) {
  const value = normalizeAddress_(headerValue);
  const angleMatch = value.match(/<([^<>\s]+@[^<>\s]+)>\s*$/);
  if (angleMatch) return angleMatch[1];
  const emailMatch = value.match(/[^\s<>"',;]+@[^\s<>"',;]+/);
  return emailMatch ? emailMatch[0] : value;
}

function formatDate_(date) {
  return Utilities.formatDate(date, CONFIG.timeZone, 'yyyy/MM/dd HH:mm');
}

function escapeHtml_(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
