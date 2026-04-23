import { GameObjectDefs } from "../../../../shared/defs/gameObjectDefs";
import type { GunDef } from "../../../../shared/defs/gameObjects/gunDefs";
import { GameConfig } from "../../../../shared/gameConfig";
import * as net from "../../../../shared/net/net";
import { ObjectType } from "../../../../shared/net/objectSerializeFns";
import { coldet } from "../../../../shared/utils/coldet";
import { collisionHelpers } from "../../../../shared/utils/collisionHelpers";
import { math } from "../../../../shared/utils/math";
import { util } from "../../../../shared/utils/util";
import { type Vec2, v2 } from "../../../../shared/utils/v2";
import { Config } from "../../config";
import type { Game } from "../game";
import type { Player } from "../objects/player";

export type BotDifficulty = "normal" | "hard" | "pro";

const DifficultySettings: Record<
    BotDifficulty,
    {
        aimJitterDeg: number;
        reactionDelay: number;
    }
> = {
    normal: {
        aimJitterDeg: 8,
        reactionDelay: 0.35,
    },
    hard: {
        aimJitterDeg: 3,
        reactionDelay: 0.2,
    },
    pro: {
        aimJitterDeg: 0.8,
        reactionDelay: 0.08,
    },
};

export class BotController {
    private _time = 0;

    private _seq = 0;

    private _decisionTicker = 0;

    private _waypoint?: Vec2;
    private _waypointTtl = 0;

    private _targetId?: number;
    private _targetVisible = false;
    private _targetSeenTime = -Infinity;
    private _targetChangedTime = -Infinity;

    private _lastPos: Vec2;
    private _lastMovedTime = 0;

    private _strafeTicker = 0;
    private _strafeSign = 1;

    constructor(
        readonly game: Game,
        readonly player: Player,
        readonly difficulty: BotDifficulty,
    ) {
        this._lastPos = v2.copy(player.pos);
    }

    /**
     * True when bot has seen an enemy recently (used for retire priority).
     */
    get inCombat(): boolean {
        return this._time - this._targetSeenTime < 1.0;
    }

    /**
     * Seconds since bot last moved significantly (used for retire priority).
     */
    get secondsSinceMove(): number {
        return this._time - this._lastMovedTime;
    }

    update(dt: number): void {
        this._time += dt;

        const player = this.player;
        if (player.dead || player.downed || player.disconnected) {
            return;
        }

        if (!this._targetId) {
            this._waypointTtl -= dt;
        }

        const movedDist = v2.distance(player.pos, this._lastPos);
        if (movedDist > 0.5) {
            this._lastPos = v2.copy(player.pos);
            this._lastMovedTime = this._time;
        }

        const decisionInterval = 1 / math.max(Config.bots.decisionTps, 1);
        this._decisionTicker += dt;
        if (this._decisionTicker >= decisionInterval) {
            this._decisionTicker %= decisionInterval;
            this._decide();
        }

        const msg = this._buildInput(dt);
        player.handleInput(msg);
    }

    private _decide(): void {
        const player = this.player;

        const vision = player.zoom + 6;
        const rect = coldet.circleToAabb(player.pos, vision);
        const objects = this.game.grid.intersectCollider(rect);

        let bestVisible: Player | undefined;
        let bestVisibleDist = Number.MAX_VALUE;

        let bestAny: Player | undefined;
        let bestAnyDist = Number.MAX_VALUE;

        for (let i = 0; i < objects.length; i++) {
            const obj = objects[i];
            if (obj.__type !== ObjectType.Player) continue;
            const other = obj as Player;
            if (other === player) continue;
            if (other.dead || other.disconnected) continue;
            if (!util.sameLayer(other.layer, player.layer)) continue;

            // Ignore friendlies
            if (other.groupId === player.groupId) continue;
            if (this.game.map.factionMode && other.teamId === player.teamId) continue;

            // Optional bot-vs-bot suppression (internal + external websocket bots)
            if (!Config.bots.allowBotVsBot && (other.isAi || other.bot)) continue;

            const dist = v2.lengthSqr(v2.sub(other.pos, player.pos));
            if (dist < bestAnyDist) {
                bestAnyDist = dist;
                bestAny = other;
            }

            if (dist >= bestVisibleDist) continue;
            if (!this._hasLineOfSight(other)) continue;
            bestVisibleDist = dist;
            bestVisible = other;
        }

        const chosen = bestVisible ?? bestAny;
        if (chosen) {
            this._targetVisible = bestVisible === chosen;
            if (this._targetId !== chosen.__id) {
                this._targetId = chosen.__id;
                this._targetChangedTime = this._time;
            }

            // Count as combat if we can see them
            if (this._targetVisible) {
                this._targetSeenTime = this._time;
            }
        } else {
            this._targetId = undefined;
            this._targetVisible = false;
        }

        // Pick/refresh waypoint when not actively targeting
        if (!this._targetId) {
            if (!this._waypoint || this._waypointTtl <= 0) {
                this._waypoint = this._pickWaypoint();
                this._waypointTtl = util.random(5, 10);
            }
        }
    }

    private _pickWaypoint(): Vec2 {
        const map = this.game.map;
        const gas = this.game.gas;

        const center = gas.posNew;
        const baseRad = math.max(gas.radNew * 0.75, 10);

        for (let attempts = 0; attempts < 12; attempts++) {
            const candidate = v2.add(center, util.randomPointInCircle(baseRad));

            // Clamp to bounds
            candidate.x = math.clamp(candidate.x, 0, map.width);
            candidate.y = math.clamp(candidate.y, 0, map.height);

            if (gas.isOutSideSafeZone(candidate)) continue;
            if (map.isOnWater(candidate, 0)) continue;

            return candidate;
        }

        // Fallback: just move toward gas center
        return v2.copy(center);
    }

    private _hasLineOfSight(target: Player): boolean {
        const a = this.player.pos;
        const b = target.pos;
        const len = v2.distance(a, b);
        if (len <= 0.0001) return true;

        const dir = v2.normalizeSafe(v2.sub(b, a), v2.create(1, 0));
        const aabb = coldet.lineSegmentToAabb(a, b);
        const nearby = this.game.grid.intersectCollider(aabb);
        const obstacles = nearby.filter((o) => o.__type === ObjectType.Obstacle) as any[];

        const dist = collisionHelpers.intersectSegmentDist(
            obstacles,
            a,
            dir,
            len,
            GameConfig.bullet.height,
            this.player.layer,
            true,
        );

        return dist >= len - 0.05;
    }

    private _buildInput(dt: number): net.InputMsg {
        const player = this.player;
        const settings = DifficultySettings[this.difficulty];

        const msg = new net.InputMsg();
        msg.seq = this._seq++ % 256;

        const targetObj = this._targetId
            ? this.game.objectRegister.getById(this._targetId)
            : undefined;
        const target =
            targetObj && targetObj.__type === ObjectType.Player
                ? (targetObj as Player)
                : undefined;
        const validTarget =
            target &&
            !target.dead &&
            !target.disconnected &&
            util.sameLayer(target.layer, player.layer)
                ? target
                : undefined;

        if (!validTarget) {
            this._targetId = undefined;
            this._targetVisible = false;
        }

        const gas = this.game.gas;
        const gasEmergency = gas.isInGas(player.pos) || gas.isOutSideSafeZone(player.pos);

        let goal: Vec2 | undefined;
        if (gasEmergency) {
            goal = gas.posNew;
        } else if (validTarget) {
            goal = validTarget.pos;
        } else if (this._waypoint) {
            goal = this._waypoint;
        }

        // Aim
        let aimDir = v2.create(1, 0);
        let aimLen = 0;

        if (validTarget) {
            const baseDir = v2.normalizeSafe(v2.sub(validTarget.pos, player.pos), v2.create(1, 0));
            const jitter = math.deg2rad(util.random(-settings.aimJitterDeg, settings.aimJitterDeg));
            aimDir = v2.rotate(baseDir, jitter);
            aimLen = v2.distance(player.pos, validTarget.pos);
        } else if (goal) {
            aimDir = v2.normalizeSafe(v2.sub(goal, player.pos), v2.create(1, 0));
            aimLen = v2.distance(player.pos, goal);
        }

        msg.toMouseDir = aimDir;
        msg.toMouseLen = math.clamp(aimLen, 0, net.Constants.MouseMaxDist);

        // Movement
        msg.moveLeft = false;
        msg.moveRight = false;
        msg.moveUp = false;
        msg.moveDown = false;

        if (goal) {
            const toGoal = v2.sub(goal, player.pos);
            const dist = v2.length(toGoal);

            const dd = 1;
            const strafe = !!validTarget && dist < 18 && !gasEmergency;
            if (strafe) {
                this._strafeTicker -= dt;
                if (this._strafeTicker <= 0) {
                    this._strafeTicker = util.random(0.25, 0.6);
                    this._strafeSign = Math.random() < 0.5 ? -1 : 1;
                }

                const perp = v2.perp(aimDir);
                const strafeGoal = v2.add(player.pos, v2.mul(perp, 8 * this._strafeSign));
                if (strafeGoal.x > player.pos.x + dd) msg.moveRight = true;
                else if (strafeGoal.x < player.pos.x - dd) msg.moveLeft = true;
                if (strafeGoal.y > player.pos.y + dd) msg.moveUp = true;
                else if (strafeGoal.y < player.pos.y - dd) msg.moveDown = true;
            } else {
                if (goal.x > player.pos.x + dd) msg.moveRight = true;
                else if (goal.x < player.pos.x - dd) msg.moveLeft = true;
                if (goal.y > player.pos.y + dd) msg.moveUp = true;
                else if (goal.y < player.pos.y - dd) msg.moveDown = true;
            }
        }

        // Use items
        msg.useItem = "";
        if (!player.downed && player.actionType === GameConfig.Action.None) {
            if (player.health < 60) {
                if (player.inventory["healthkit"] > 0) msg.useItem = "healthkit";
                else if (player.inventory["bandage"] > 0) msg.useItem = "bandage";
            } else if (player.boost < 40) {
                if (player.inventory["painkiller"] > 0) msg.useItem = "painkiller";
                else if (player.inventory["soda"] > 0) msg.useItem = "soda";
            }
        }

        // Shooting
        msg.shootHold = false;
        msg.shootStart = false;

        if (validTarget && this._targetVisible && !gasEmergency) {
            const ready =
                this._time - this._targetChangedTime >= settings.reactionDelay;
            if (ready) {
                const def = GameObjectDefs[player.activeWeapon];
                if (def?.type === "gun") {
                    const gun = def as GunDef;
                    if (gun.fireMode === "auto" || gun.fireMode === "burst") {
                        msg.shootHold = true;
                    } else {
                        msg.shootStart = true;
                    }
                } else {
                    // melee/throwables: treat as hold
                    msg.shootHold = true;
                }
            }
        }

        // Quickswitch
        if (
            Config.bots.enableQuickSwitch &&
            (this.difficulty === "hard" || this.difficulty === "pro")
        ) {
            const curIdx = player.curWeapIdx;
            if (
                curIdx === GameConfig.WeaponSlot.Primary ||
                curIdx === GameConfig.WeaponSlot.Secondary
            ) {
                const activeDef = GameObjectDefs[player.activeWeapon];
                if (activeDef?.type === "gun" && player.shotSlowdownTimer > 0) {
                    const gunDef = activeDef as GunDef;
                    if (gunDef.fireDelay - player.shotSlowdownTimer > 0.25) {
                        const otherIdx = curIdx ^ 1;
                        const otherType = player.weapons[otherIdx].type;
                        const otherDef = otherType ? GameObjectDefs[otherType] : undefined;
                        if (otherDef?.type === "gun") {
                            msg.addInput(
                                otherIdx === GameConfig.WeaponSlot.Primary
                                    ? GameConfig.Input.EquipPrimary
                                    : GameConfig.Input.EquipSecondary,
                            );
                        }
                    }
                }
            }
        }

        // Ensure internal bots behave like mobile for auto doors/pickup
        msg.touchMoveActive = false;

        return msg;
    }
}
