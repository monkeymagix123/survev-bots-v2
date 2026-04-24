import { GameObjectDefs } from "../../../../shared/defs/gameObjectDefs";
import type { BulletDef } from "../../../../shared/defs/gameObjects/bulletDefs";
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

type WeaponClass = "shotgun" | "smg" | "ar" | "lmg" | "precision" | "pistol";

type SkillProfile = {
    reactionMinSec: number;
    reactionMaxSec: number;
    trackingDegPerSec: number;
    baseAimErrorDeg: number;
    predictionLeadScale: number;
    losGraceSec: number;
};

type WeaponProfile = {
    idealMin: number;
    idealMax: number;
    engageMax: number;

    aimGateDeg: number;
    bloomPerShotDeg: number;
    bloomDecayDegPerSec: number;

    minFocusTimeSec?: number; // precision-only
    stopToShoot?: boolean; // precision-only

    burstDistMin?: number;
    burstHoldSec?: number;
    burstPauseSec?: number;

    postShotNoFireSec?: number; // shotgun-only
    tapOnly?: boolean; // pistol-only
};

const SkillProfiles: Record<BotDifficulty, SkillProfile> = {
    normal: {
        reactionMinSec: 0.25,
        reactionMaxSec: 0.45,
        trackingDegPerSec: 280,
        baseAimErrorDeg: 3.5,
        predictionLeadScale: 0.45,
        losGraceSec: 0.25,
    },
    hard: {
        reactionMinSec: 0.15,
        reactionMaxSec: 0.25,
        trackingDegPerSec: 420,
        baseAimErrorDeg: 1.8,
        predictionLeadScale: 0.75,
        losGraceSec: 0.12,
    },
    pro: {
        reactionMinSec: 0.06,
        reactionMaxSec: 0.1,
        trackingDegPerSec: 650,
        baseAimErrorDeg: 0.8,
        predictionLeadScale: 0.95,
        losGraceSec: 0.05,
    },
};

function classifyWeapon(gunDef: GunDef): WeaponClass {
    if (gunDef.pistol === true) return "pistol";

    if (
        gunDef.ammo === "12gauge" ||
        gunDef.bulletCount >= 5 ||
        gunDef.shotSpread >= 8
    ) {
        return "shotgun";
    }

    if (gunDef.maxClip >= 45 || gunDef.extendedClip >= 75) {
        return "lmg";
    }

    if (gunDef.fireMode === "auto" && gunDef.ammo === "9mm") {
        return "smg";
    }

    if (
        gunDef.fireMode === "single" &&
        (gunDef.aimDelay === true || gunDef.fireDelay >= 1.2 || gunDef.maxClip <= 10)
    ) {
        return "precision";
    }

    if (gunDef.fireMode === "burst" || gunDef.fireMode === "auto") {
        return "ar";
    }

    return "ar";
}

function getWeaponProfile(weaponClass: WeaponClass, difficulty: BotDifficulty): WeaponProfile {
    switch (weaponClass) {
        case "shotgun":
            return {
                idealMin: 0,
                idealMax: 10,
                engageMax: 13,
                aimGateDeg:
                    difficulty === "pro" ? 3.5 : difficulty === "hard" ? 7 : 10,
                bloomPerShotDeg: 1.0,
                bloomDecayDegPerSec: 4.0,
                postShotNoFireSec: 0.25,
            };
        case "smg":
            return {
                idealMin: 0,
                idealMax: 18,
                engageMax: 26,
                aimGateDeg:
                    difficulty === "pro" ? 2 : difficulty === "hard" ? 4 : 7,
                bloomPerShotDeg: 0.35,
                bloomDecayDegPerSec: 2.8,
                burstDistMin: 16,
                burstHoldSec: 0.18,
                burstPauseSec: 0.12,
            };
        case "ar": {
            const aimGateDeg = difficulty === "pro" ? 1.8 : difficulty === "hard" ? 3.5 : 6;
            const burstHoldSec = difficulty === "pro" ? 0.26 : difficulty === "hard" ? 0.22 : 0.18;
            const burstPauseSec = difficulty === "pro" ? 0.12 : difficulty === "hard" ? 0.16 : 0.18;
            return {
                idealMin: 6,
                idealMax: 24,
                engageMax: 32,
                aimGateDeg,
                bloomPerShotDeg: 0.25,
                bloomDecayDegPerSec: 2.4,
                burstDistMin: 20,
                burstHoldSec,
                burstPauseSec,
            };
        }
        case "lmg":
            return {
                idealMin: 10,
                idealMax: 28,
                engageMax: 36,
                aimGateDeg:
                    difficulty === "pro" ? 2.2 : difficulty === "hard" ? 4 : 7,
                bloomPerShotDeg: 0.3,
                bloomDecayDegPerSec: 2.0,
            };
        case "precision": {
            const aimGateDeg =
                difficulty === "pro" ? 0.6 : difficulty === "hard" ? 1.2 : 2.5;
            const minFocusTimeSec =
                difficulty === "pro" ? 0.12 : difficulty === "hard" ? 0.25 : 0.45;
            return {
                idealMin: 18,
                idealMax: 60,
                engageMax: 70,
                aimGateDeg,
                bloomPerShotDeg: 0.8,
                bloomDecayDegPerSec: 3.5,
                minFocusTimeSec,
                stopToShoot: true,
            };
        }
        case "pistol":
            return {
                idealMin: 0,
                idealMax: 16,
                engageMax: 24,
                aimGateDeg:
                    difficulty === "pro" ? 2 : difficulty === "hard" ? 4 : 7,
                bloomPerShotDeg: 0.25,
                bloomDecayDegPerSec: 3.0,
                tapOnly: true,
            };
    }
}

function wrapAngleRad(rad: number): number {
    return Math.atan2(Math.sin(rad), Math.cos(rad));
}

function approachAngleRad(curRad: number, targetRad: number, maxDeltaRad: number): number {
    const delta = wrapAngleRad(targetRad - curRad);
    if (Math.abs(delta) <= maxDeltaRad) return targetRad;
    return curRad + Math.sign(delta) * maxDeltaRad;
}

function absAngleDiffDeg(aRad: number, bRad: number): number {
    return Math.abs(math.rad2deg(wrapAngleRad(bRad - aRad)));
}

function randomNormal(mean: number, stdDev: number): number {
    if (stdDev <= 0) return mean;

    // Box–Muller transform
    let u = 0;
    let v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
    return mean + z * stdDev;
}

function movingAimPenaltyDeg(difficulty: BotDifficulty): number {
    switch (difficulty) {
        case "normal":
            return 1.5;
        case "hard":
            return 0.9;
        case "pro":
            return 0.4;
    }
}

export class BotController {
    private _time = 0;

    private _seq = 0;

    private _decisionTicker = 0;

    private _waypoint?: Vec2;
    private _waypointTtl = 0;

    private _targetId?: number;
    private _targetVisible = false;
    private _targetSeenTime = -Infinity;

    // Aim/shoot model state
    private _aimAngleRad = 0;
    private _targetAngleRad = 0;
    private _focusTime = 0;
    private _nextShootTime = -Infinity;
    private _bloomDeg = 0;
    private _burstHoldT = 0;
    private _burstPauseT = 0;
    private _postShotNoFireT = 0;
    private _lastTargetId?: number;
    private _lastVisible = false;
    private _lostLosTime = -Infinity;

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
        this._aimAngleRad = Math.atan2(player.dir.y, player.dir.x);
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
        const skill = SkillProfiles[this.difficulty];

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
        const prevTargetId = this._targetId;
        const prevVisible = this._targetVisible;

        if (chosen) {
            const newTargetId = chosen.__id;
            const newVisible = bestVisible === chosen;

            this._targetId = newTargetId;
            this._targetVisible = newVisible;

            if (prevTargetId !== newTargetId) {
                this._lastTargetId = prevTargetId;
                this._focusTime = 0;
                this._nextShootTime =
                    this._time + util.random(skill.reactionMinSec, skill.reactionMaxSec);
                this._burstHoldT = 0;
                this._burstPauseT = 0;
                this._postShotNoFireT = 0;
                this._lastVisible = newVisible;
                this._lostLosTime = -Infinity;
            } else {
                // Track LOS-loss time for grace firing (only after having LOS)
                if (prevVisible && !newVisible && this._lastVisible) {
                    this._lostLosTime = this._time;
                }
                this._lastVisible = newVisible;
            }

            // Count as combat if we can see them
            if (newVisible) {
                this._targetSeenTime = this._time;
            }
        } else {
            if (prevTargetId !== undefined) {
                this._lastTargetId = prevTargetId;
            }
            this._targetId = undefined;
            this._targetVisible = false;
            this._focusTime = 0;
            this._burstHoldT = 0;
            this._burstPauseT = 0;
            this._postShotNoFireT = 0;
            this._lastVisible = false;
            this._lostLosTime = -Infinity;
            this._nextShootTime = -Infinity;
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
        const skill = SkillProfiles[this.difficulty];

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

        const activeDef = GameObjectDefs[player.activeWeapon];
        const gunDef = activeDef?.type === "gun" ? (activeDef as GunDef) : undefined;
        const weaponClass = gunDef ? classifyWeapon(gunDef) : undefined;
        const profile = weaponClass ? getWeaponProfile(weaponClass, this.difficulty) : undefined;

        // Decrement timers
        this._postShotNoFireT = Math.max(this._postShotNoFireT - dt, 0);

        // Aim + prediction
        let aimLen = 0;
        let distToTarget = Infinity;

        if (validTarget) {
            distToTarget = v2.distance(player.pos, validTarget.pos);
            aimLen = distToTarget;

            let predictedPos = validTarget.pos;
            if (gunDef) {
                const bulletDef = GameObjectDefs[gunDef.bulletType] as BulletDef | undefined;
                const bulletSpeed = bulletDef?.speed ?? 1;
                const tLead = math.clamp(
                    (distToTarget / Math.max(bulletSpeed, 1)) * skill.predictionLeadScale,
                    0,
                    0.35,
                );
                predictedPos = v2.add(validTarget.pos, v2.mul(validTarget.moveVel, tLead));
            }

            this._targetAngleRad = Math.atan2(
                predictedPos.y - player.pos.y,
                predictedPos.x - player.pos.x,
            );
        } else if (goal) {
            aimLen = v2.distance(player.pos, goal);
            this._targetAngleRad = Math.atan2(goal.y - player.pos.y, goal.x - player.pos.x);
        }

        const maxDeltaRad = math.deg2rad(skill.trackingDegPerSec) * dt;
        this._aimAngleRad = approachAngleRad(
            this._aimAngleRad,
            this._targetAngleRad,
            maxDeltaRad,
        );
        const aimDir = v2.create(Math.cos(this._aimAngleRad), Math.sin(this._aimAngleRad));
        const angleDeltaDeg = absAngleDiffDeg(this._aimAngleRad, this._targetAngleRad);

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

        // Precision "stop to shoot" focus time
        const standStillForPrecision =
            !!validTarget &&
            !!profile?.stopToShoot &&
            weaponClass === "precision" &&
            this._targetVisible &&
            distToTarget >= profile.idealMin &&
            distToTarget <= profile.idealMax &&
            this._time >= this._nextShootTime &&
            angleDeltaDeg <= profile.aimGateDeg * 2;

        if (standStillForPrecision) {
            msg.moveLeft = false;
            msg.moveRight = false;
            msg.moveUp = false;
            msg.moveDown = false;
            this._focusTime += dt;
        } else {
            this._focusTime = 0;
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

        // Burst timer state machine (only used when profile enables it)
        const burstEnabled =
            !!validTarget &&
            !!profile?.burstDistMin &&
            !!profile.burstHoldSec &&
            !!profile.burstPauseSec &&
            distToTarget > profile.burstDistMin;

        if (!burstEnabled) {
            this._burstHoldT = 0;
            this._burstPauseT = 0;
        } else {
            const burstHoldSec = profile.burstHoldSec!;
            const burstPauseSec = profile.burstPauseSec!;
            if (this._burstPauseT > 0) {
                this._burstPauseT = Math.max(this._burstPauseT - dt, 0);
            } else if (this._burstHoldT > 0) {
                const prevHold = this._burstHoldT;
                this._burstHoldT = Math.max(this._burstHoldT - dt, 0);
                if (prevHold > 0 && this._burstHoldT === 0) {
                    this._burstPauseT = burstPauseSec;
                }
            }
            if (this._burstPauseT <= 0 && this._burstHoldT <= 0) {
                this._burstHoldT = burstHoldSec;
            }
        }

        const burstGateOk = !burstEnabled || this._burstPauseT <= 0;

        let allowShooting = false;
        if (validTarget && profile && !gasEmergency) {
            const inRange = distToTarget <= profile.engageMax;
            const reactionReady = this._time >= this._nextShootTime;
            const aimReady = angleDeltaDeg <= profile.aimGateDeg;
            const postShotReady = this._postShotNoFireT <= 0;

            const visibleNow = this._targetVisible;
            const graceAllowed =
                (weaponClass === "smg" ||
                    weaponClass === "ar" ||
                    weaponClass === "lmg" ||
                    weaponClass === "pistol") &&
                this._time - this._lostLosTime <= skill.losGraceSec;
            const losOk = visibleNow || graceAllowed;

            allowShooting =
                inRange && reactionReady && aimReady && postShotReady && losOk && burstGateOk;

            if (allowShooting && weaponClass === "precision") {
                const minFocus = profile.minFocusTimeSec ?? 0;
                if (!visibleNow || this._focusTime < minFocus) {
                    allowShooting = false;
                }
            }
        }

        if (allowShooting) {
            if (profile?.tapOnly || gunDef?.fireMode === "single") {
                msg.shootStart = true;
            } else {
                msg.shootHold = true;
            }
        }

        // Compute whether a shot will fire this tick (used for bloom + per-shot noise)
        const weapon = player.weapons[player.curWeapIdx];
        const cooldownAfter = weapon.cooldown - dt;
        let willShootThisTick = false;
        let startingBurstThisTick = false;
        if (gunDef) {
            if (gunDef.fireMode === "auto") {
                willShootThisTick = msg.shootHold && cooldownAfter <= 0;
            } else if (gunDef.fireMode === "single") {
                willShootThisTick = msg.shootStart && cooldownAfter < 0;
            } else if (gunDef.fireMode === "burst") {
                const scheduled =
                    player.weaponManager.bursts.length > 0 &&
                    player.weaponManager.bursts.some((t) => t <= dt);
                startingBurstThisTick = msg.shootHold && cooldownAfter < 0;
                willShootThisTick = scheduled || startingBurstThisTick;
            }
        } else {
            // Non-gun: treat as "hold"
            willShootThisTick = msg.shootHold;
        }

        // Bloom/spread update (bot-only)
        if (profile) {
            this._bloomDeg = Math.max(0, this._bloomDeg - profile.bloomDecayDegPerSec * dt);

            if (willShootThisTick) {
                if (gunDef?.fireMode === "burst" && startingBurstThisTick) {
                    const burstCount = gunDef.burstCount ?? 1;
                    this._bloomDeg += profile.bloomPerShotDeg * burstCount;
                } else if (gunDef?.fireMode !== "burst") {
                    this._bloomDeg += profile.bloomPerShotDeg;
                }

                if (weaponClass === "shotgun" && profile.postShotNoFireSec) {
                    this._postShotNoFireT = profile.postShotNoFireSec;
                }
            }

            // Prevent rare outlier behavior where bloom grows without bound (e.g. extended fights).
            const bloomMaxDeg =
                weaponClass === "precision" ? 8 : weaponClass === "shotgun" ? 15 : 12;
            this._bloomDeg = Math.min(this._bloomDeg, bloomMaxDeg);
        }

        // Aim noise only on shot ticks (keeps aim from vibrating constantly)
        let noiseDeg = 0;
        if (willShootThisTick && profile) {
            let spreadDeg = skill.baseAimErrorDeg + this._bloomDeg;

            const movingThisTick =
                msg.moveLeft || msg.moveRight || msg.moveUp || msg.moveDown;
            if (movingThisTick) {
                let movePenalty = movingAimPenaltyDeg(this.difficulty);
                if (weaponClass === "precision") {
                    movePenalty *= 0.5;
                }
                spreadDeg += movePenalty;
            }

            noiseDeg = randomNormal(0, spreadDeg);

            // Truncate normal tails so rare samples don't look like 360° sprays in spectate.
            const cap = Math.min(25, spreadDeg * 3);
            noiseDeg = math.clamp(noiseDeg, -cap, cap);
        }

        const shotAngleRad = this._aimAngleRad + math.deg2rad(noiseDeg);
        msg.toMouseDir = v2.create(Math.cos(shotAngleRad), Math.sin(shotAngleRad));

        // Quickswitch
        if (
            Config.bots.enableQuickSwitch &&
            (this.difficulty === "hard" || this.difficulty === "pro")
        ) {
            if (this._burstHoldT > 0) {
                // avoid swapping weapons mid-burst window
            } else {
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
        }

        // Ensure internal bots behave like mobile for auto doors/pickup
        msg.touchMoveActive = false;

        return msg;
    }
}
