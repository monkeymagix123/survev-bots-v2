import { GameObjectDefs } from "../../../../shared/defs/gameObjectDefs";
import type { GunDef } from "../../../../shared/defs/gameObjects/gunDefs";
import { GameConfig } from "../../../../shared/gameConfig";
import * as net from "../../../../shared/net/net";
import type { Vec2 } from "../../../../shared/utils/v2";
import { Config } from "../../config";
import type { Game } from "../game";
import type { Group } from "../group";
import type { Team } from "../team";
import { Player } from "../objects/player";
import type { BotBrainType } from "./botBrain";
import { BotController, type BotDifficulty } from "./botController";
import * as fs from "fs";
import * as path from "path";

// ─── Wave config types ────────────────────────────────────────────────────────

interface WaveEntry {
    count: number;
    /**
     * Optional exact counts per brain type.
     * Values are treated as counts, not weights.
     * If omitted or counts don't sum to `count`, remaining slots use random brain selection.
     */
    brains?: Partial<Record<BotBrainType, number>>;
    difficulty?: BotDifficulty;
}

interface WaveConfig {
    waves: WaveEntry[];
}

// ─── Brain weight helpers ─────────────────────────────────────────────────────

const DefaultBrainWeights: Record<BotBrainType, number> = {
    practice: 0.15,
    realistic: 0.8,
    competitive: 0.05,
};

function normalizeBrainWeights(
    weights?: Partial<Record<BotBrainType, number>>,
): Record<BotBrainType, number> {
    if (!weights) {
        return DefaultBrainWeights;
    }

    const raw = {
        practice: Math.max(weights.practice ?? 0, 0),
        realistic: Math.max(weights.realistic ?? 0, 0),
        competitive: Math.max(weights.competitive ?? 0, 0),
    };

    const sum = raw.practice + raw.realistic + raw.competitive;
    if (sum <= 0) {
        return DefaultBrainWeights;
    }

    return {
        practice: raw.practice / sum,
        realistic: raw.realistic / sum,
        competitive: raw.competitive / sum,
    };
}

function sampleBrainType(weights: Record<BotBrainType, number>): BotBrainType {
    const r = Math.random();
    let acc = 0;

    acc += weights.practice;
    if (r < acc) return "practice";

    acc += weights.realistic;
    if (r < acc) return "realistic";

    return "competitive";
}

/**
 * Builds a shuffled queue of brain types for a wave entry.
 * Exact counts from `entry.brains` are honoured first; any remaining
 * slots (due to missing / mismatched counts) are filled with random picks.
 */
function buildBrainQueue(
    entry: WaveEntry,
    pickRandom: () => BotBrainType,
): BotBrainType[] {
    const queue: BotBrainType[] = [];

    if (entry.brains) {
        for (const [brainType, count] of Object.entries(entry.brains) as [BotBrainType, number][]) {
            const n = Math.max(0, Math.floor(count));
            for (let i = 0; i < n; i++) {
                queue.push(brainType);
            }
        }

        const sum = queue.length;
        if (sum !== entry.count) {
            console.warn(
                `[BotManager] Wave brain counts sum to ${sum} but wave count is ${entry.count}. ` +
                `Filling ${Math.max(0, entry.count - sum)} remaining slot(s) randomly.`,
            );
            const remaining = Math.max(0, entry.count - sum);
            for (let i = 0; i < remaining; i++) {
                queue.push(pickRandom());
            }
        }
    } else {
        // No explicit brain breakdown — all random
        for (let i = 0; i < entry.count; i++) {
            queue.push(pickRandom());
        }
    }

    // Fisher-Yates shuffle so brain types interleave naturally
    for (let i = queue.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [queue[i], queue[j]] = [queue[j], queue[i]];
    }

    return queue;
}

// ─── Wave state ───────────────────────────────────────────────────────────────

interface WaveState {
    /** Index into the loaded WaveConfig.waves array */
    index: number;
    /** How many bots have already been spawned for the current wave */
    spawned: number;
    /**
     * __id values of every bot spawned in this wave.
     * Used to detect "all wave bots dead" without touching unrelated bots.
     */
    botIds: Set<number>;
    /** True once all bots in this wave have died and we are waiting to advance */
    waitingForNext: boolean;
    /** Pre-built, shuffled queue of brain types — one entry per bot to spawn */
    brainQueue: BotBrainType[];
}

/** Seconds to pause between waves. Adjust to taste. */
const WAVE_INTER_DELAY_S = 3;

// ─── BotManager ──────────────────────────────────────────────────────────────

export class BotManager {
    private _nextBotId = 0;

    private _spawnBudget = 0;
    private _retireBudget = 0;

    private readonly _controllers = new Map<number, BotController>();

    // ── Wave mode ──
    /** Null when wave mode is disabled, or waves.json is absent/malformed */
    private readonly _waveConfig: WaveConfig | null;
    private _wave: WaveState | null = null;
    /** Countdown timer used for the inter-wave delay */
    private _waveDelayRemaining = 0;
    /** True when waves are paused due to insufficient connected humans */
    private _wavePausedForNoHumans = false;

    constructor(readonly game: Game) {
        const waveModeEnabled = !!this.game.map.mapDef.isWave;
        this._waveConfig = waveModeEnabled ? this._loadWaveConfig() : null;

        if (waveModeEnabled && !this._waveConfig) {
            console.warn(
                "[BotManager] Wave map is active but no valid waves.json was found. Wave mode disabled.",
            );
        } else if (this._waveConfig) {
            console.log(
                `[BotManager] Wave mode active — ${this._waveConfig.waves.length} wave(s) loaded.`,
            );
            this._beginWave(0);
        }
    }

    // ── Wave config loading ──────────────────────────────────────────────────

    private _loadWaveConfig(): WaveConfig | null {
        // Look for waves.json next to this file (server/src/game/bots/waves.json)
        const candidates = [
            path.resolve(__dirname, "waves.json"),
            path.resolve(process.cwd(), "../waves.json"),
            path.resolve(process.cwd(), "waves.json"),
        ];

        for (const filePath of candidates) {
            if (!fs.existsSync(filePath)) continue;

            try {
                const raw = fs.readFileSync(filePath, "utf8");
                const parsed = JSON.parse(raw) as WaveConfig;

                if (
                    !Array.isArray(parsed.waves) ||
                    parsed.waves.length === 0 ||
                    parsed.waves.some(
                        (w) => typeof w.count !== "number" || w.count < 1,
                    )
                ) {
                    console.warn(
                        `[BotManager] waves.json at ${filePath} is invalid — ignoring.`,
                    );
                    return null;
                }

                console.log(`[BotManager] Loaded waves.json from ${filePath}`);
                return parsed;
            } catch (err) {
                console.warn(
                    `[BotManager] Failed to parse waves.json at ${filePath}:`,
                    err,
                );
            }
        }

        return null;
    }

    // ── Wave lifecycle ───────────────────────────────────────────────────────

    private _beginWave(index: number): void {
        if (!this._waveConfig) return;

        if (index >= this._waveConfig.waves.length) {
            console.log("[BotManager] All waves complete.");
            this._wave = null;
            return;
        }

        this._cleanupDeadInternalBots();

        const entry = this._waveConfig.waves[index];
        const brainQueue = buildBrainQueue(entry, () => this._pickBrainType());

        this._wave = {
            index,
            spawned: 0,
            botIds: new Set(),
            waitingForNext: false,
            brainQueue,
        };

        const brainSummary = Object.entries(
            brainQueue.reduce<Record<string, number>>((acc, b) => {
                acc[b] = (acc[b] ?? 0) + 1;
                return acc;
            }, {}),
        )
            .map(([b, n]) => `${n}x ${b}`)
            .join(", ");

        console.log(
            `[BotManager] Starting wave ${index + 1}/${this._waveConfig.waves.length} ` +
            `— ${entry.count} bot(s) [${brainSummary}], ` +
            `difficulty: ${entry.difficulty ?? "default"}.`,
        );
    }

    private _currentWaveEntry(): WaveEntry | null {
        if (!this._waveConfig || !this._wave) return null;
        return this._waveConfig.waves[this._wave.index] ?? null;
    }

    private _countConnectedHumans(): number {
        const players = this.game.playerBarn.players;
        let connectedHumans = 0;

        for (let i = 0; i < players.length; i++) {
            const p = players[i];
            // Humans are websocket-backed, connected, and not external websocket "bots" (JoinMsg.bot=true)
            if (p.hasClient && !p.disconnected && !p.bot) {
                connectedHumans++;
            }
        }

        return connectedHumans;
    }

    private _pauseWaveModeForNoHumans(): void {
        if (this._wavePausedForNoHumans) return;
        this._wavePausedForNoHumans = true;

        this._wave = null;
        this._waveDelayRemaining = 0;
        this._spawnBudget = 0;
    }

    private _resumeWaveModeIfNeeded(): void {
        if (!this._wavePausedForNoHumans) return;
        this._wavePausedForNoHumans = false;

        // Restart at wave 1 whenever a match becomes human-populated again.
        if (this._waveConfig) {
            this._beginWave(0);
        }
    }

    private _removeAllInternalBots(): void {
        const playerBarn = this.game.playerBarn;
        const bots = playerBarn.players.filter((p) => p.isAi && !p.destroyed);
        for (let i = 0; i < bots.length; i++) {
            const bot = bots[i];
            this._controllers.delete(bot.__id);
            playerBarn.removePlayer(bot);
        }
    }

    private _cleanupDeadInternalBots(): void {
        const playerBarn = this.game.playerBarn;
        const deadBots = playerBarn.players.filter(
            (p) => p.isAi && !p.destroyed && p.dead,
        );
        for (let i = 0; i < deadBots.length; i++) {
            const bot = deadBots[i];
            this._controllers.delete(bot.__id);
            playerBarn.removePlayer(bot);
        }
    }

    private _cleanupWaveBots(botIds: Set<number>): void {
        if (botIds.size === 0) return;

        const playerBarn = this.game.playerBarn;
        const bots = playerBarn.players.filter(
            (p) => p.isAi && !p.destroyed && p.dead && botIds.has(p.__id),
        );

        for (let i = 0; i < bots.length; i++) {
            const bot = bots[i];
            this._controllers.delete(bot.__id);
            playerBarn.removePlayer(bot);
        }

        botIds.clear();
    }

    // ── Main update ──────────────────────────────────────────────────────────

    update(dt: number): void {
        this._updateControllers(dt);

        const isWaveMap = !!this.game.map.mapDef.isWave;
        const botsEnabled = Config.bots.enabled || isWaveMap;

        if (!botsEnabled) {
            return;
        }

        if (this.game.stopped || this.game.over) {
            return;
        }

        if (isWaveMap) {
            const connectedHumans = this._countConnectedHumans();

            // No bot-only games: if there are no connected humans, remove internal bots and
            // reset wave progression so a future join starts from wave 1 again.
            if (connectedHumans < Config.bots.minHumansToEnable) {
                this._pauseWaveModeForNoHumans();
                this._removeAllInternalBots();
                return;
            }

            if (!this._waveConfig) return;
            this._resumeWaveModeIfNeeded();
            this._updateWaveMode(dt);
            return;
        }

        // Fill/retire only while the lobby is open / joinable
        if (this.game.gas.stage >= 2) {
            return;
        }

        const fill = this._computeFillTarget();
        this._applyFillTarget(dt, fill);
    }

    // ── Wave-mode update ─────────────────────────────────────────────────────

    private _updateWaveMode(dt: number): void {
        const wave = this._wave;

        // All waves exhausted
        if (!wave) return;

        const entry = this._currentWaveEntry()!;

        // ── Phase 1: spawn remaining bots for the current wave ──
        if (wave.spawned < entry.count && !wave.waitingForNext) {
            this._spawnBudget += dt * Math.max(Config.bots.spawnPerSecond, 0);

            while (wave.spawned < entry.count && this._spawnBudget >= 1) {
                // Pop the next brain type from the pre-built queue
                const brainType = wave.brainQueue[wave.spawned] ?? this._pickBrainType();
                const difficulty = entry.difficulty ?? this._pickDifficulty();
                const id = this._spawnInternalBot(brainType, difficulty);

                if (id !== undefined) {
                    wave.botIds.add(id);
                    wave.spawned++;
                }
                this._spawnBudget -= 1;
            }
        }

        // ── Phase 2: detect wave completion (all wave bots dead) ──
        if (wave.spawned >= entry.count && !wave.waitingForNext) {
            const anyAlive = this.game.playerBarn.livingPlayers.some(
                (p) => p.isAi && wave.botIds.has(p.__id),
            );

            if (!anyAlive) {
                this._cleanupWaveBots(wave.botIds);
                console.log(
                    `[BotManager] Wave ${wave.index + 1} cleared — next wave in ${WAVE_INTER_DELAY_S}s.`,
                );
                wave.waitingForNext = true;
                this._waveDelayRemaining = WAVE_INTER_DELAY_S;
            }
        }

        // ── Phase 3: inter-wave delay then advance ──
        if (wave.waitingForNext) {
            this._waveDelayRemaining -= dt;
            if (this._waveDelayRemaining <= 0) {
                this._beginWave(wave.index + 1);
            }
        }
    }

    // ── Controller management ────────────────────────────────────────────────

    private _updateControllers(dt: number): void {
        const livingPlayers = this.game.playerBarn.livingPlayers;

        for (let i = 0; i < livingPlayers.length; i++) {
            const player = livingPlayers[i];
            if (!player.isAi) continue;

            let controller = this._controllers.get(player.__id);
            if (!controller) {
                const brainType = this._pickBrainType();
                controller = new BotController(
                    this.game,
                    player,
                    this._pickDifficulty(),
                    brainType,
                );
                this._controllers.set(player.__id, controller);
            }

            controller.update(dt);
        }

        // Clean up controllers for retired/dead bots
        for (const [id, controller] of this._controllers) {
            const player = controller.player;
            if (player.destroyed || player.dead || !player.isAi || player.__id !== id) {
                this._controllers.delete(id);
            }
        }
    }

    private _pickDifficulty(): BotDifficulty {
        const base = Config.bots.difficulty;
        if (base === "pro") return "pro";
        if (Math.random() < Config.bots.proChance) return "pro";
        return base;
    }

    private _pickBrainType(): BotBrainType {
        const mix = Config.bots.brainMix;
        if (mix.force) {
            return mix.force;
        }

        const weights = normalizeBrainWeights(mix.weights);
        return sampleBrainType(weights);
    }

    // ── Fill-mode helpers ────────────────────────────────────────────────────

    private _computePendingJoinSlots(now: number): number {
        let pendingJoinSlots = 0;
        for (const [token, data] of this.game.joinTokens) {
            if (data.expiresAt < now || data.availableUses <= 0) {
                this.game.joinTokens.delete(token);
                continue;
            }
            pendingJoinSlots += data.availableUses;
        }
        return pendingJoinSlots;
    }

    private _computeFillTarget(): {
        desiredBots: number;
        connectedHumans: number;
    } {
        const now = Date.now();
        const pendingJoinSlots = this._computePendingJoinSlots(now);

        const maxPlayers = this.game.map.mapDef.gameMode.maxPlayers;
        const desiredTotalPlayers = Math.min(
            maxPlayers,
            Math.max(2, maxPlayers - Config.bots.reserveSlots),
        );

        // Use total participants (not just alive) so bots don't "respawn" as players die.
        const players = this.game.playerBarn.players;

        let occupiedNonAi = 0;
        let connectedHumans = 0;

        for (let i = 0; i < players.length; i++) {
            const p = players[i];
            if (p.isAi) {
                continue;
            }

            occupiedNonAi++;

            // Humans are websocket-backed, connected, and not external websocket "bots" (JoinMsg.bot=true)
            if (p.hasClient && !p.disconnected && !p.bot) {
                connectedHumans++;
            }
        }

        let desiredBots =
            desiredTotalPlayers - occupiedNonAi - pendingJoinSlots;
        desiredBots = mathClamp(desiredBots, 0, Config.bots.maxBots ?? desiredTotalPlayers);

        if (connectedHumans < Config.bots.minHumansToEnable) {
            desiredBots = 0;
        }

        return { desiredBots, connectedHumans };
    }

    private _applyFillTarget(
        dt: number,
        fill: { desiredBots: number; connectedHumans: number },
    ): void {
        const spawnRate = Math.max(Config.bots.spawnPerSecond, 0);
        this._spawnBudget += dt * spawnRate;
        this._retireBudget += dt * spawnRate;

        // Total internal bots, including dead ones (prevents infinite re-spawning during lobby).
        const players = this.game.playerBarn.players;
        let bots = 0;
        for (let i = 0; i < players.length; i++) {
            if (players[i].isAi) bots++;
        }

        // Spawn
        while (bots < fill.desiredBots && this._spawnBudget >= 1) {
            if (this._spawnInternalBot() !== undefined) {
                bots++;
            }
            this._spawnBudget -= 1;
        }

        // Retire
        while (bots > fill.desiredBots && this._retireBudget >= 1) {
            const retired = this._retireOneBot(fill.connectedHumans);
            if (!retired) {
                break;
            }
            bots--;
            this._retireBudget -= 1;
        }
    }

    // ── Internal bot spawning ────────────────────────────────────────────────

    private _spawnInternalBot(
        brainType?: BotBrainType,
        difficulty?: BotDifficulty,
    ): number | undefined {
        const playerBarn = this.game.playerBarn;
        const isWaveMap = !!this.game.map.mapDef.isWave;

        let group: Group | undefined;
        let team: Team | undefined;

        if (this.game.map.factionMode) {
            if (isWaveMap) {
                // Wave map: internal bots always spawn on Team 2 (Blue).
                team =
                    playerBarn.teams.find((t) => t.teamId === 2) ??
                    playerBarn.teams[1] ??
                    playerBarn.getSmallestTeam();
            } else {
                team = playerBarn.getSmallestTeam();
            }
        }

        // Simple policy: every bot is its own group (even in Duo/Squad).
        if (this.game.isTeamMode) {
            group = playerBarn.addGroup(false);
        }

        let pos: Vec2;
        let layer: number;

        if (this.game.map.perkMode && this.game.map.perkModeTwinsBunker) {
            const spawnBuilding = this.game.map.perkModeTwinsBunker;
            pos = spawnBuilding.pos;
            layer = spawnBuilding.layer;
        } else {
            pos = this.game.map.getSpawnPos(group, team);
            layer = 0;
        }

        const joinMsg = new net.JoinMsg();
        joinMsg.protocol = GameConfig.protocolVersion;
        joinMsg.name = `Bot_${this._nextBotId + 1}`;
        joinMsg.isMobile = true; // mobile enables auto-doors + auto-pickup (looting is implicit for now)
        joinMsg.bot = false; // internal bot, not an external websocket bot

        const socketId = `ai:${this.game.id}:${++this._nextBotId}`;
        const bot = new Player(this.game, pos, layer, socketId, joinMsg);

        bot.isAi = true;
        bot.hasClient = false;

        if (team && group) {
            team.addPlayer(bot);
            group.addPlayer(bot);
        } else if (!team && group) {
            group.addPlayer(bot);
            bot.teamId = group.groupId;
        } else if (team && !group) {
            team.addPlayer(bot);
            bot.groupId = playerBarn.groupIdAllocator.getNextId();
        } else {
            bot.groupId = playerBarn.groupIdAllocator.getNextId();
            bot.teamId = bot.groupId;
        }

        if (bot.game.map.factionMode) {
            bot.playerStatusDirty = true;
        }

        if (bot.game.map.perkMode) {
            bot.roleMenuTicker = GameConfig.player.perkModeRoleSelectDuration + 5;
        }

        if (!bot.game.map.perkMode && group && !group.spawnLeader) {
            group.spawnLeader = bot;
        }

        // Register the controller immediately with the resolved brain type so
        // wave-assigned brain types are used rather than falling back to random
        // in _updateControllers on the first tick.
        const resolvedBrain = brainType ?? this._pickBrainType();
        const resolvedDifficulty = difficulty ?? this._pickDifficulty();
        const controller = new BotController(
            this.game,
            bot,
            resolvedDifficulty,
            resolvedBrain,
        );
        this._controllers.set(bot.__id, controller);

        this._applyStartingLoadout(bot);

        playerBarn.newPlayers.push(bot);
        this.game.objectRegister.register(bot);
        playerBarn.players.push(bot);
        playerBarn.livingPlayers.push(bot);

        if (!this.game.modeManager.isSolo) {
            playerBarn.livingPlayers.sort((a, b) => a.teamId - b.teamId);
        }
        playerBarn.aliveCountDirty = true;

        this.game.pluginManager.emit("playerJoin", bot);

        // Ensure a started transition when internal bots bring alive contexts above 1
        if (!this.game.started) {
            this.game.started = this.game.modeManager.isGameStarted();
            if (this.game.started) {
                this.game.gas.advanceGasStage();
            }
        }

        this.game.updateData();

        return bot.__id;
    }

    private _applyStartingLoadout(bot: Player): void {
        // Perk mode roles grant their own loadouts; keep internal bots neutral here for now.
        if (this.game.map.perkMode) return;

        const exclude = new Set<string>();
        const primary = this._pickLootGun(exclude);
        if (primary) {
            exclude.add(primary);
            this._equipGun(bot, GameConfig.WeaponSlot.Primary, primary);
        }

        const secondary = this._pickLootGun(exclude);
        if (secondary) {
            exclude.add(secondary);
            this._equipGun(bot, GameConfig.WeaponSlot.Secondary, secondary);
        }

        if (primary) {
            bot.weaponManager.setCurWeapIndex(
                GameConfig.WeaponSlot.Primary,
                true,
                true,
                true,
            );
            // Spawn holding the gun immediately (avoid a draw delay on first tick)
            bot.weapons[GameConfig.WeaponSlot.Primary].cooldown = 0;
        }
    }

    private _pickLootGun(exclude: Set<string>): string | undefined {
        const tier = this.game.map.mapDef.lootTable["tier_guns"] ? "tier_guns" : "tier_world";
        for (let attempt = 0; attempt < 30; attempt++) {
            const items = this.game.lootBarn.getLootTable(tier);
            if (!items.length) return undefined;

            const item = items[0];
            const type = item.name;
            if (!type) continue;
            if (exclude.has(type)) continue;

            const def = GameObjectDefs[type];
            if (def?.type !== "gun") continue;

            return type;
        }

        return undefined;
    }

    private _equipGun(bot: Player, slot: number, gunType: string): void {
        const def = GameObjectDefs[gunType];
        if (def?.type !== "gun") return;

        const gunDef = def as GunDef;
        const trueMaxClip = bot.weaponManager.getTrueAmmoStats(gunDef).trueMaxClip;
        bot.weaponManager.setWeapon(slot, gunType, trueMaxClip);

        const ammoType = gunDef.ammo;
        const backpackLevel = bot.getGearLevel(bot.backpack);
        const bagSpace = bot.bagSizes[ammoType]
            ? bot.bagSizes[ammoType][backpackLevel]
            : 0;
        if (!bagSpace) return;

        const extraAmmo = Math.max(gunDef.ammoSpawnCount - trueMaxClip, 0);
        if (!extraAmmo) return;

        bot.inventory[ammoType] = Math.min(bagSpace, bot.inventory[ammoType] + extraAmmo);
        bot.inventoryDirty = true;
    }

    // ── Retire (fill mode only) ──────────────────────────────────────────────

    private _retireOneBot(connectedHumans: number): boolean {
        const playerBarn = this.game.playerBarn;

        const livingBots = playerBarn.livingPlayers.filter((p) => p.isAi);
        if (livingBots.length === 0) return false;

        const enforceNoEnd = connectedHumans >= Config.bots.minHumansToEnable;

        let candidates = livingBots;
        if (enforceNoEnd) {
            candidates = candidates.filter((b) => !this._wouldEndMatchIfRetired(b));
            if (candidates.length === 0) {
                return false;
            }
        }

        if (this.game.map.factionMode) {
            candidates = this._preferLargestFactionTeam(candidates);
        }

        const chosen = this._pickRetireCandidate(candidates);
        if (!chosen) return false;

        this._controllers.delete(chosen.__id);
        playerBarn.removePlayer(chosen);

        // removePlayer already calls checkGameOver() and updateData()
        return true;
    }

    private _preferLargestFactionTeam(bots: Player[]): Player[] {
        const teams = this.game.playerBarn.teams;
        if (!teams.length) return bots;

        let largestTeam: Team | undefined;
        let largestSize = -1;
        for (let i = 0; i < teams.length; i++) {
            const t = teams[i];
            const size = t.livingPlayers.length;
            if (size > largestSize) {
                largestSize = size;
                largestTeam = t;
            }
        }

        if (!largestTeam) return bots;

        const filtered = bots.filter((b) => b.team === largestTeam);
        return filtered.length ? filtered : bots;
    }

    private _pickRetireCandidate(bots: readonly Player[]): Player | undefined {
        let best: Player | undefined;
        let bestScore = -Infinity;

        for (let i = 0; i < bots.length; i++) {
            const bot = bots[i];
            const controller = this._controllers.get(bot.__id);

            const inCombat = controller?.inCombat ?? false;
            const secondsSinceMove = controller?.secondsSinceMove ?? 0;

            let score = 0;
            if (inCombat) score -= 1000;
            score += Math.min(secondsSinceMove, 10);
            score += Math.random() * 0.01;

            if (score > bestScore) {
                bestScore = score;
                best = bot;
            }
        }

        return best;
    }

    private _wouldEndMatchIfRetired(bot: Player): boolean {
        if (!this.game.started) return false;

        // Faction mode: alive contexts are teams
        if (this.game.map.factionMode) {
            const aliveTeams = this.game.playerBarn.getAliveTeams().length;
            if (aliveTeams <= 1) return true;

            const wouldRemoveTeam = bot.team ? bot.team.livingPlayers.length <= 1 : true;
            return wouldRemoveTeam && aliveTeams <= 2;
        }

        // Team mode: alive contexts are groups
        if (this.game.isTeamMode) {
            const aliveGroups = this.game.playerBarn.getAliveGroups().length;
            if (aliveGroups <= 1) return true;

            const wouldRemoveGroup = bot.group ? bot.group.livingPlayers.length <= 1 : true;
            return wouldRemoveGroup && aliveGroups <= 2;
        }

        // Normal solos: alive contexts are players
        const alivePlayers = this.game.playerBarn.livingPlayers.length;
        return alivePlayers <= 2;
    }
}

function mathClamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}
