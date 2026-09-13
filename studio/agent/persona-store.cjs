'use strict';

/* Reach Studio — custom agent (persona) + team persistence.
 *
 * Personas are reusable agent definitions: a name, an optional model
 * override, and a custom system prompt ("instructions"). Teams assemble
 * personas into a crew that runs either:
 *
 *   mode 'parallel' — every member gets the SAME task and they all run
 *                      simultaneously (fan-out; e.g. 3 models racing the
 *                      same problem, or splitting independent subtasks).
 *   mode 'chain'     — members run one after another; each member's final
 *                      message is passed to the next as context, so the
 *                      crew communicates through the relayed transcript.
 *
 * Stored in userData/personas.json alongside agents.json, atomic writes.
 */

const fs = require('fs');
const path = require('path');

const MAX_PERSONAS = 40;
const MAX_TEAMS = 40;
const MAX_TEAM_MEMBERS = 8;

function newId(prefix) {
  return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

class PersonaStore {
  constructor(filePath) {
    this.filePath = filePath;
    const loaded = this._load();
    this.personas = loaded.personas;
    this.teams = loaded.teams;
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      return {
        personas: raw && Array.isArray(raw.personas) ? raw.personas.filter(p => p && typeof p.id === 'string') : [],
        teams: raw && Array.isArray(raw.teams) ? raw.teams.filter(t => t && typeof t.id === 'string') : [],
      };
    } catch {
      return { personas: [], teams: [] };
    }
  }

  _save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = this.filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ personas: this.personas, teams: this.teams }, null, 2));
    fs.renameSync(tmp, this.filePath);
  }

  // ---------- personas ----------
  listPersonas() {
    return this.personas.map(p => ({ ...p }));
  }

  getPersona(id) {
    return this.personas.find(p => p.id === id) || null;
  }

  createPersona({ name, model = '', prompt = '', color = '' }) {
    if (this.personas.length >= MAX_PERSONAS) {
      throw new Error(`Persona limit reached (${MAX_PERSONAS}).`);
    }
    const persona = {
      id: newId('persona'),
      name: String(name || 'Agent').slice(0, 60),
      model: String(model || ''),
      prompt: String(prompt || '').slice(0, 8000),
      color: String(color || ''),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.personas.push(persona);
    this._save();
    return persona;
  }

  updatePersona(id, patch) {
    const p = this.getPersona(id);
    if (!p) return null;
    if (patch.name !== undefined) p.name = String(patch.name).slice(0, 60);
    if (patch.model !== undefined) p.model = String(patch.model);
    if (patch.prompt !== undefined) p.prompt = String(patch.prompt).slice(0, 8000);
    if (patch.color !== undefined) p.color = String(patch.color);
    p.updatedAt = Date.now();
    this._save();
    return p;
  }

  removePersona(id) {
    const before = this.personas.length;
    this.personas = this.personas.filter(p => p.id !== id);
    // Drop the persona from any team that referenced it.
    for (const t of this.teams) {
      t.members = (t.members || []).filter(m => m.personaId !== id);
    }
    if (this.personas.length !== before) this._save();
    return this.personas.length !== before;
  }

  // ---------- teams ----------
  listTeams() {
    return this.teams.map(t => ({
      ...t,
      members: (t.members || []).map(m => {
        const p = this.getPersona(m.personaId);
        return { ...m, personaName: p ? p.name : '(deleted)', personaModel: p ? p.model : '' };
      }),
    }));
  }

  getTeam(id) {
    return this.teams.find(t => t.id === id) || null;
  }

  createTeam({ name, mode = 'parallel', members = [] }) {
    if (this.teams.length >= MAX_TEAMS) {
      throw new Error(`Team limit reached (${MAX_TEAMS}).`);
    }
    if (!['parallel', 'chain'].includes(mode)) {
      throw new Error('Team mode must be "parallel" or "chain".');
    }
    const team = {
      id: newId('team'),
      name: String(name || 'Team').slice(0, 60),
      mode,
      members: this._validateMembers(members),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.teams.push(team);
    this._save();
    return team;
  }

  _validateMembers(members) {
    if (!Array.isArray(members)) throw new Error('members must be an array.');
    if (members.length > MAX_TEAM_MEMBERS) throw new Error(`A team can have at most ${MAX_TEAM_MEMBERS} members.`);
    const seen = new Set();
    return members.map((m, i) => {
      const personaId = m && m.personaId;
      if (!personaId || !this.getPersona(personaId)) {
        throw new Error(`Member ${i + 1} references an unknown persona.`);
      }
      // The same persona may appear twice in a team (two roles), but the
      // (personaId, role) pair must be unique so runs stay attributable.
      const key = personaId + '|' + String(m.role || '');
      if (seen.has(key)) throw new Error(`Duplicate member (same persona + role) at position ${i + 1}.`);
      seen.add(key);
      return {
        personaId,
        role: String(m.role || '').slice(0, 120),
      };
    });
  }

  updateTeam(id, patch) {
    const t = this.getTeam(id);
    if (!t) return null;
    if (patch.name !== undefined) t.name = String(patch.name).slice(0, 60);
    if (patch.mode !== undefined) {
      if (!['parallel', 'chain'].includes(patch.mode)) throw new Error('Team mode must be "parallel" or "chain".');
      t.mode = patch.mode;
    }
    if (patch.members !== undefined) t.members = this._validateMembers(patch.members);
    t.updatedAt = Date.now();
    this._save();
    return t;
  }

  removeTeam(id) {
    const before = this.teams.length;
    this.teams = this.teams.filter(t => t.id !== id);
    if (this.teams.length !== before) this._save();
    return this.teams.length !== before;
  }
}

module.exports = { PersonaStore, MAX_TEAM_MEMBERS };
