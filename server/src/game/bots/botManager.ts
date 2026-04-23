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
import { BotController, type BotDifficulty } from "./botController";

export class BotManager {
    private _nextBotId = 0;

    private _spawnBudget = 0;
    private _retireBudget = 0;

    private readonly _controllers = new Map<number, BotController>();

    constructor(readonly game: Game) {}

    update(dt: number): void {
        this._updateControllers(dt);

        if (!Config.bots.enabled) {
            return;
        }

        if (this.game.stopped || this.game.over) {
            return;
        }

        // Fill/retire only while the lobby is open / joinable
        if (this.game.gas.stage >= 2) {
            return;
        }

        const fill = this._computeFillTarget();
        this._applyFillTarget(dt, fill);
    }

    private _updateControllers(dt: number): void {
        const livingPlayers = this.game.playerBarn.livingPlayers;

        for (let i = 0; i < livingPlayers.length; i++) {
            const player = livingPlayers[i];
            if (!player.isAi) continue;

            let controller = this._controllers.get(player.__id);
            if (!controller) {
                controller = new BotController(
                    this.game,
                    player,
                    this._pickDifficulty(),
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

    private _spawnInternalBot(): number | undefined {
        const playerBarn = this.game.playerBarn;

        let group: Group | undefined;
        let team: Team | undefined;

        if (this.game.map.factionMode) {
            team = playerBarn.getSmallestTeam();
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
