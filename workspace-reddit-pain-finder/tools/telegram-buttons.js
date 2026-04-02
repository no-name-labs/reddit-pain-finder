'use strict';

/**
 * telegram-buttons.js — Send Telegram messages with reply keyboard buttons
 *
 * Usage:
 *   node telegram-buttons.js \
 *     --text "Your message here" \
 *     --buttons '[["✅ Approve","❌ Remove"],["🔄 Redo","📋 Show State"]]' \
 *     [--chat-id -1003633569118] [--topic-id 1655] [--reply-to MSG_ID]
 *     [--remove-keyboard]
 *
 * Env: TELEGRAM_BOT_TOKEN must be set.
 *
 * The agent calls this tool and then responds with NO_REPLY to suppress
 * the gateway's duplicate message. Only this tool's message appears.
 */

const https = require('https');

function parseArgs(argv) {
  const args = argv.slice(2);
  const result = {
    text: '',
    buttons: [],
    chatId: '-1003633569118',
    topicId: 1655,
    replyTo: null,
    removeKeyboard: false,
  };

  let i = 0;
  while (i < args.length) {
    switch (args[i]) {
      case '--text':
        result.text = args[++i];
        break;
      case '--buttons':
        result.buttons = JSON.parse(args[++i]);
        break;
      case '--chat-id':
        result.chatId = args[++i];
        break;
      case '--topic-id':
        result.topicId = parseInt(args[++i], 10);
        break;
      case '--reply-to':
        result.replyTo = parseInt(args[++i], 10);
        break;
      case '--remove-keyboard':
        result.removeKeyboard = true;
        break;
    }
    i++;
  }

  if (!result.text) {
    console.error('Usage: node telegram-buttons.js --text "msg" --buttons \'[["btn1","btn2"]]\'');
    process.exit(1);
  }

  return result;
}

function telegramRequest(botToken, method, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(
      {
        hostname: 'api.telegram.org',
        path: `/bot${botToken}/${method}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(buf));
          } catch {
            resolve({ ok: false, error: buf });
          }
        });
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  const args = parseArgs(process.argv);
  const botToken = process.env.TELEGRAM_BOT_TOKEN;

  if (!botToken) {
    console.error(JSON.stringify({ ok: false, error: 'TELEGRAM_BOT_TOKEN not set' }));
    process.exit(1);
  }

  const body = {
    chat_id: parseInt(args.chatId, 10),
    text: args.text,
    message_thread_id: args.topicId,
  };

  if (args.replyTo) {
    body.reply_parameters = { message_id: args.replyTo };
  }

  if (args.removeKeyboard) {
    body.reply_markup = JSON.stringify({ remove_keyboard: true });
  } else if (args.buttons.length > 0) {
    body.reply_markup = JSON.stringify({
      keyboard: args.buttons.map((row) =>
        row.map((text) => ({ text })),
      ),
      resize_keyboard: true,
      one_time_keyboard: true,
    });
  }

  const result = await telegramRequest(botToken, 'sendMessage', body);

  if (result.ok) {
    console.log(JSON.stringify({ ok: true, message_id: result.result.message_id }));
  } else {
    console.log(JSON.stringify({ ok: false, error: result.description || 'Unknown error' }));
    process.exit(1);
  }
}

main();
