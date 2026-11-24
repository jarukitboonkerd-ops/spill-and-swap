import { randomBytes, randomInt } from 'node:crypto';

import { decks, modes } from './questions.mjs';

export const newRoomCode = () => randomBytes(8).toString('hex');
const ROUND_MS = 60_000;

export class RoomError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function answerStart(room) {
  return room.deadline === null ? null : room.answerStartsAt ?? room.deadline - ROUND_MS;
}

function shuffleAnswers(answers) {
  for (let i = answers.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [answers[i], answers[j]] = [answers[j], answers[i]];
  }
  return answers;
}

export function createRoomStore({ now = Date.now, shuffle = shuffleAnswers, rooms = new Map() } = {}) {

  function find(code) {
    const room = rooms.get(code);
    if (!room) throw new RoomError(404, 'ไม่พบห้องนี้');
    return room;
  }

  function member(code, token, hostOnly = false) {
    const room = find(code);
    if (!room.players.has(token) || (hostOnly && token !== room.host)) {
      throw new RoomError(403, 'ไม่มีสิทธิ์ทำรายการนี้');
    }
    return room;
  }

  function advance(room, time) {
    if (room.phase !== 'answering') return;
    if (time < room.deadline && room.submissions.size < room.players.size) return;
    room.answers = shuffle([...room.submissions.values()]);
    room.phase = 'revealed';
  }

  function clearQuestion(room) {
    room.deadline = null;
    room.answerStartsAt = null;
    room.answers = null;
    room.submissions.clear();
    room.readyPlayers.clear();
  }

  function beginQuestion(room) {
    clearQuestion(room);
    room.roundId += 1;
    room.phase = 'answering';
    room.answerStartsAt = now() + 3000;
    room.deadline = room.answerStartsAt + ROUND_MS;
  }

  function unlockedModes(room) {
    return room.basicComplete ? ['basic', 'memories', 'multiverse'] : ['basic'];
  }

  function read(code, token) {
    const room = member(code, token);
    const serverNow = now();
    advance(room, serverNow);
    return {
      phase: room.phase,
      isHost: room.host === token,
      playerCount: room.players.size,
      submittedCount: room.submissions.size,
      hasSubmitted: room.submissions.has(token),
      roundId: room.roundId,
      deadline: room.deadline,
      answerStartsAt: answerStart(room),
      serverNow,
      question: decks[room.mode][room.questionIndex],
      mode: room.mode,
      modes: room.phase === 'modes' ? modes.map((mode) => ({
        ...mode, example: decks[mode.id]?.[0],
      })) : modes,
      unlockedModes: unlockedModes(room),
      questionNumber: room.questionIndex + 1,
      questionCount: decks[room.mode].length,
      readyCount: room.readyPlayers.size,
      isReady: room.readyPlayers.has(token),
      answers: room.answers && [...room.answers],
    };
  }

  return {
    createRoom(code = newRoomCode()) {
      if (rooms.has(code)) throw new RoomError(409, 'รหัสห้องนี้ถูกใช้แล้ว');
      const token = randomBytes(24).toString('hex');
      rooms.set(code, {
        host: token,
        players: new Set([token]),
        joinKeys: new Map(),
        phase: 'lobby',
        roundId: 0,
        mode: 'basic',
        questionIndex: 0,
        basicComplete: false,
        readyPlayers: new Set(),
        deadline: null,
        submissions: new Map(),
        answers: null,
      });
      return { code, token };
    },

    join(code, joinKey) {
      const room = find(code);
      if (typeof joinKey !== 'string' || !/^[0-9a-f]{32}$/.test(joinKey)) {
        throw new RoomError(400, 'ข้อมูลเข้าห้องไม่ถูกต้อง');
      }
      const existing = room.joinKeys.get(joinKey);
      if (existing) return { code, token: existing };
      if (room.phase !== 'lobby' && room.phase !== 'modes') {
        throw new RoomError(409, 'กำลังเล่นอยู่ ลองเข้าร่วมอีกครั้งเมื่อถึงหน้าเลือกโหมด');
      }
      const token = randomBytes(24).toString('hex');
      room.players.add(token);
      room.joinKeys.set(joinKey, token);
      return { code, token };
    },

    start(code, token) {
      const room = member(code, token, true);
      if (room.phase !== 'lobby') throw new RoomError(409, 'รอบนี้เริ่มไปแล้ว');
      beginQuestion(room);
      return read(code, token);
    },

    submit(code, token, roundId, text) {
      const room = member(code, token);
      const time = now();
      if (room.phase !== 'answering' || time < answerStart(room) || time >= room.deadline ||
          room.roundId !== roundId || room.submissions.has(token)) {
        throw new RoomError(409, 'รอบนี้ปิดรับหรือส่งคำตอบไปแล้ว');
      }
      const answer = typeof text === 'string' ? text.trim() : '';
      if (!answer || [...answer].length > 500) {
        throw new RoomError(400, 'กรอกคำตอบความยาว 1–500 ตัวอักษร');
      }
      room.submissions.set(token, answer);
      return read(code, token);
    },

    read,

    ready(code, token, roundId, isReady) {
      const room = member(code, token);
      if (room.phase !== 'revealed' || room.roundId !== roundId) {
        throw new RoomError(409, 'คำถามนี้ยังไม่เปิดคำตอบหรือผ่านไปแล้ว');
      }
      if (isReady) room.readyPlayers.add(token);
      else room.readyPlayers.delete(token);

      if (room.readyPlayers.size === room.players.size) {
        if (room.questionIndex + 1 < decks[room.mode].length) {
          room.questionIndex += 1;
          beginQuestion(room);
        } else {
          if (room.mode === 'basic') room.basicComplete = true;
          clearQuestion(room);
          room.phase = 'modes';
        }
      }
      return read(code, token);
    },

    selectMode(code, token, mode) {
      const room = member(code, token, true);
      if (room.phase !== 'modes' || !unlockedModes(room).includes(mode)) {
        throw new RoomError(409, 'ยังเลือกโหมดนี้ไม่ได้');
      }
      room.mode = mode;
      room.questionIndex = 0;
      beginQuestion(room);
      return read(code, token);
    },
  };
}
