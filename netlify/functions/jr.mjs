/*
 * Реле для проверки в заявке — «почтовый ящик» на Netlify.
 *
 * Зачем переехали с Cloudflare. Сам ящик работал, но его адрес
 * *.workers.dev у российских операторов закрыт. Бот до него доставал
 * через VPN, и в журнале всё выглядело исправным, а браузер человека
 * не доставал — ответ проверки терялся, и человека уводило в бота.
 * Netlify с мобильных данных открывается, поэтому ящик живёт здесь.
 *
 * Что здесь НЕ проверяется — и правильно. Реле не знает ни токена бота,
 * ни секретов площадок, и подпись Telegram проверить не может. Оно просто
 * передаёт письмо как есть. Всё важное проверяет бот, когда забирает:
 * и подпись, и билет заявки, и токен у площадки. Поэтому чужой мусор в
 * ящике безобиден — бот его отбросит.
 *
 * Хранилище — Netlify Blobs. Выбрано затем, что его не надо заводить:
 * ни базы, ни номера базы, ни отдельной привязки. Ровно то место, где
 * на Cloudflare люди спотыкались.
 */
import { getStore } from '@netlify/blobs';

export const config = { path: '/jr/*' };

// Письма живут десять минут: столько же, сколько сама проверка. Дальше они
// никому не нужны, а ящик должен оставаться пустым.
const LIFETIME_SECONDS = 600;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  });

// Билет заявки приходит с улицы и может содержать что угодно. Имя записи
// собираем сами, из безопасных букв: иначе на косом билете хранилище
// откажет, и ответ человека потеряется на ровном месте.
const safeKey = (value) =>
  Array.from(String(value))
    .map((ch) => ch.codePointAt(0).toString(16))
    .join('')
    .slice(0, 400);

const now = () => Math.floor(Date.now() / 1000);

export default async (request) => {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  const mail = getStore('captcha-mail');
  const rules = getStore('captcha-rules');
  const stamp = now();

  // Проверка жизни. Её открывает и бот при запуске, и вы в браузере —
  // в том числе с телефона без VPN, чтобы убедиться, что людям ящик виден.
  if (path === '/jr/ping' || path === '/jr') {
    let waiting = 0;
    try {
      const { blobs } = await mail.list();
      waiting = blobs.length;
    } catch (e) {
      return json({ ok: false, error: 'Хранилище недоступно: ' + e }, 500);
    }
    // «ok: true» бот ждёт именно в таком виде — как от себя самого.
    // now отдаём, чтобы бот мог сверить часы. Время записи письма ставит
    // реле, а вычитает его бот — разойдись часы на десяток секунд, и
    // задержка окажется выдуманной, а искать её будут по-настоящему.
    return json({ ok: true, relay: true, waiting, now: stamp });
  }

  // Страница присылает ответ проверки. Секрет здесь не нужен и не должен
  // быть нужен: страница лежит открыто, и любой секрет в ней — не секрет.
  if (path === '/jr/done' && request.method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ ok: false, error: 'bad json' }, 400);
    }
    const jr = String((body && body.jr) || '');
    if (!jr || jr.length > 512) {
      return json({ ok: false, error: 'bad ticket' }, 400);
    }
    try {
      // Один билет — одно письмо: имя записи от билета и зависит, поэтому
      // двойное нажатие просто перезапишет то же самое.
      await mail.setJSON(safeKey(jr), {
        jr,
        token: String((body && body.token) || '').slice(0, 4096),
        initData: String((body && body.initData) || '').slice(0, 4096),
        born: stamp,
      });
    } catch (e) {
      return json({ ok: false, error: 'Записать не вышло: ' + e }, 500);
    }
    // Страница ждёт «ok». Что бот скажет на самом деле, она уже не узнает —
    // и не надо: дальше человека впускает бот, а страница закрывается.
    return json({ ok: true, queued: true });
  }

  // Правила чата: бот кладёт, страница читает. Класть — только с тайным
  // словом, читать может кто угодно: правила и так висят в чате открыто.
  if (path === '/jr/rules') {
    if (request.method === 'POST') {
      const key = url.searchParams.get('key') || '';
      if (!process.env.RELAY_KEY || key !== process.env.RELAY_KEY) {
        return json({ ok: false, error: 'forbidden' }, 403);
      }
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return json({ ok: false, error: 'bad json' }, 400);
      }
      const chat = String((body && body.chat) || '');
      if (!chat) return json({ ok: false, error: 'bad chat' }, 400);
      await rules.setJSON(safeKey(chat), {
        text: String((body && body.text) || '').slice(0, 4096),
        accept: (body && body.accept) ? 1 : 0,
        born: stamp,
      });
      return json({ ok: true });
    }
    const chat = url.searchParams.get('chat') || '';
    if (!chat) return json({ ok: false, error: 'bad chat' }, 400);
    const row = await rules.get(safeKey(chat), { type: 'json' });
    if (!row) return json({ ok: true, text: '', accept: 0 });
    return json({ ok: true, text: row.text || '', accept: row.accept ? 1 : 0 });
  }

  // Бот забирает письма. Вот здесь тайное слово обязательно: иначе чужой
  // прочитал бы ответы проверок вместе с подписями Telegram.
  if (path === '/jr/take') {
    const key = url.searchParams.get('key') || '';
    if (!process.env.RELAY_KEY || key !== process.env.RELAY_KEY) {
      return json({ ok: false, error: 'forbidden' }, 403);
    }
    const out = [];
    try {
      // Бот присылает билеты, ответа по которым ждёт. Читать по имени
      // важно: перечисление в объектном хранилище показывает только что
      // записанное с задержкой в десятки секунд, а чтение по имени отдаёт
      // его сразу. Именно на этом человек терял полминуты после капчи.
      const asked = (url.searchParams.get('jr') || '')
        .split(',').map((one) => one.trim()).filter(Boolean).slice(0, 20);
      const keys = asked.length
        ? asked.map(safeKey)
        : (await mail.list()).blobs.map((b) => b.key);
      // Перечисление всё равно делаем, когда бот ничего не назвал: после
      // его перезапуска билеты забыты, а письма в ящике остались.
      for (const key of keys) {
        const row = await mail.get(key, { type: 'json' });
        if (!row) { continue; }
        await mail.delete(key);
        // Просроченное не отдаём, но и не держим: заодно и уборка.
        if (stamp - (row.born || 0) <= LIFETIME_SECONDS) {
          // born отдаём затем, чтобы бот мог сказать, сколько письмо
          // пролежало. Без этого не отличить «медленное хранилище» от
          // «человек долго решал» — а лечится это по-разному.
          out.push({ jr: row.jr, token: row.token, initData: row.initData,
                     born: row.born });
        }
      }
    } catch (e) {
      return json({ ok: false, error: 'Прочитать не вышло: ' + e }, 500);
    }
    // Поле называется именно items: его и читает бот. Названо иначе —
    // бот заберёт письма из ящика и молча выбросит, а человек останется
    // за дверью. Ровно так и случилось при переезде с Cloudflare.
    return json({ ok: true, items: out });
  }

  return json({ ok: false, error: 'unknown path' }, 404);
};
