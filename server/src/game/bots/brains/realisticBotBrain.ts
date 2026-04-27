import { GameConfig } from "../../../../../shared/gameConfig";
import { ObjectType } from "../../../../../shared/net/objectSerializeFns";
import { coldet } from "../../../../../shared/utils/coldet";
import { collisionHelpers } from "../../../../../shared/utils/collisionHelpers";
import { math } from "../../../../../shared/utils/math";
import { util } from "../../../../../shared/utils/util";
import { v2 } from "../../../../../shared/utils/v2";
import { Config } from "../../../config";
import type { BotBrainType } from "../botBrain";
import type { BotBrain, BotBrainContext } from "./botBrainLogic";

type BrainTuning = {
    rangeSlack: number;
    retreatDangerMin: number;
    highDangerMin: number;
    chaseTtlSec: number;
    mistakeChance: number;
};

const BrainTunings: Record<BotBrainType, BrainTuning> = {
    practice: {
        rangeSlack: 3,
        retreatDangerMin: 0.7,
        highDangerMin: 0.85,
        chaseTtlSec: 0.8,
        mistakeChance: 0.1,
    },
    realistic: {
        rangeSlack: 2,
        retreatDangerMin: 0.55,
        highDangerMin: 0.75,
        chaseTtlSec: 1.6,
        mistakeChance: 0.05,
    },
    competitive: {
        rangeSlack: 1,
        retreatDangerMin: 0.45,
        highDangerMin: 0.65,
        chaseTtlSec: 2.5,
        mistakeChance: 0.0,
    },
};

function clamp01(x: number): number {
    return math.clamp(x, 0, 1);
}

/**
 * Phase 1: behavior-preserving brain that matches the current bot logic.
 * Phase 2+: will diverge into more human-like decision-making.
 */
export class RealisticBotBrain implements BotBrain {
    readonly type: BotBrainType = "realistic";

    decide(ctx: BotBrainContext): void {
        const {
            game,
            player,
            timeNow,
            perception,
            navigation,
            combat,
            aim,
            weaponLogic,
        } = ctx;

        const scan = perception.scanForTarget(game, player);

        const prevTargetId = perception.targetId;
        const prevVisible = perception.targetVisible;

        const chosen = scan.target;
        if (chosen) {
            const newTargetId = chosen.__id;
            const newVisible = scan.visible;

            perception.targetId = newTargetId;
            perception.targetVisible = newVisible;

            if (prevTargetId !== newTargetId) {
                aim.resetFocus();
                weaponLogic.onTargetChanged(timeNow, newVisible);
                perception.lastSeenPos = undefined;
                perception.lastSeenTime = -Infinity;
            } else {
                weaponLogic.onVisibilityUpdate(prevVisible, newVisible, timeNow);
            }

            if (newVisible) {
                perception.markTargetVisible(timeNow, chosen.pos);
            }
        } else {
            perception.targetId = undefined;
            perception.targetVisible = false;
            perception.lastSeenPos = undefined;
            perception.lastSeenTime = -Infinity;
            aim.resetFocus();
            weaponLogic.onTargetCleared();
        }

        const prevState = combat.state;

        if (!perception.targetId) {
            combat.setState("wander", timeNow, "no_target");
            combat.goalPos = undefined;
            combat.movementStyle = "direct";
            navigation.ensureWaypoint(game, player);

            if (Config.bots.debugCombat && prevState !== combat.state) {
                const { gunDef, weaponClass } = weaponLogic.getWeaponInfo(player);
                const activeWeapon = player.weapons[player.curWeapIdx];
                const ammoType = gunDef?.ammo;
                const spareAmmo = ammoType ? player.inventory[ammoType] : 0;
                const needsReload =
                    player.isReloading() ||
                    (!!gunDef && activeWeapon.ammo === 0 && spareAmmo > 0);

                const gas = game.gas;
                const gasEmergency =
                    gas.isInGas(player.pos) || gas.isOutSideSafeZone(player.pos);

                console.log("[botCombat]", {
                    brainType: this.type,
                    state: combat.state,
                    stateReason: combat.stateReason,
                    danger: 0,
                    hp: Math.round(player.health),
                    dist: undefined,
                    visible: false,
                    recentlyDamaged: timeNow - combat.lastDamagedTime < 0.45,
                    needsReload,
                    gasEmergency,
                    weaponClass,
                });
            }
            return;
        }

        // ── Combat state selection (movement-only) ──

        const tuning = BrainTunings[this.type];

        const target = scan.target!;
        const distToTarget = v2.distance(player.pos, target.pos);

        const { gunDef, weaponClass, profile } = weaponLogic.getWeaponInfo(player);

        const idealMin = profile?.idealMin ?? 0;
        const idealMax = profile?.idealMax ?? 18;
        const rangeSlack = tuning.rangeSlack;

        const lowHp = player.health < 60;
        const recentlyDamaged = timeNow - combat.lastDamagedTime < 0.45;
        const visible = perception.targetVisible;

        const activeWeapon = player.weapons[player.curWeapIdx];
        const ammoType = gunDef?.ammo;
        const spareAmmo = ammoType ? player.inventory[ammoType] : 0;
        const isReloading = player.isReloading();
        const needsReload =
            isReloading || (!!gunDef && activeWeapon.ammo === 0 && spareAmmo > 0);

        const gas = game.gas;
        const gasEmergency = gas.isInGas(player.pos) || gas.isOutSideSafeZone(player.pos);

        let danger = 0;
        if (visible) danger += 0.38;
        danger += clamp01(1 - distToTarget / 20) * 0.22;
        if (lowHp) danger += 0.22;
        if (needsReload) danger += isReloading ? 0.18 : 0.14;
        if (recentlyDamaged) danger += 0.12;
        if (gasEmergency) danger += 0.25;
        danger = clamp01(danger);

        const lastSeenFresh =
            !visible &&
            !!perception.lastSeenPos &&
            timeNow - perception.lastSeenTime <= tuning.chaseTtlSec;

        type State = typeof combat.state;

        let state: State = "hold_range";
        let reason = "default";

        const newDamageSinceLastDodge =
            combat.lastDamagedTime > combat.damageDodgeUntil - 0.35;
        if (recentlyDamaged && newDamageSinceLastDodge) {
            const alreadyDodging = timeNow < combat.damageDodgeUntil;
            combat.damageDodgeUntil = timeNow + 0.35;
            if (!alreadyDodging) {
                combat.damageDodgeSign = Math.random() < 0.5 ? -1 : 1;
            }
        }
        const damageDodging = timeNow < combat.damageDodgeUntil;

        if (lowHp && danger >= tuning.retreatDangerMin) {
            state = "retreat_heal";
            reason = "low_hp";
        } else if (needsReload && danger >= tuning.retreatDangerMin) {
            state = "retreat_reload";
            reason = "reload_under_threat";
        } else if (damageDodging && !lowHp && !needsReload && !gasEmergency) {
            if (distToTarget < idealMin - rangeSlack) {
                state = "back_off";
                reason = "too_close";
            } else {
                state = "strafe";
                reason = "damage_dodge";
            }
        } else if ((lowHp || needsReload) && danger >= tuning.highDangerMin) {
            state = "seek_cover";
            reason = "high_danger";
        } else if (lastSeenFresh) {
            state = "chase_last_seen";
            reason = "lost_los";
        } else if (distToTarget < idealMin - rangeSlack) {
            state = "back_off";
            reason = "too_close";
        } else if (distToTarget > idealMax + rangeSlack) {
            state = "push";
            reason = "too_far";
        } else {
            // In usable band: pick a holding style (anchor/strafe/etc).
            if (weaponClass === "precision") {
                state = this.type === "competitive" ? "hold_position" : "hold_range";
                reason = "precision_hold";
            } else if (weaponClass === "lmg") {
                state = this.type === "competitive" ? "hold_position" : "hold_range";
                reason = "lmg_hold";
            } else if (
                weaponClass === "shotgun" ||
                weaponClass === "smg" ||
                weaponClass === "pistol"
            ) {
                state = "strafe";
                reason = "close_weapon_strafe";
            } else if (weaponClass === "ar") {
                state = this.type === "competitive" ? "hold_position" : "strafe";
                reason = "ar_hold";
            } else {
                state = "hold_range";
                reason = "in_band";
            }

            // Practice/realistic can occasionally pick a weaker in-band choice.
            if (tuning.mistakeChance > 0 && Math.random() < tuning.mistakeChance) {
                state = "hold_range";
                reason = "mistake_hold_range";
            }
        }

        const stateChanged = prevState !== state;
        combat.setState(state, timeNow, reason);

        if (Config.bots.debugCombat && stateChanged) {
            console.log("[botCombat]", {
                brainType: this.type,
                state,
                stateReason: reason,
                danger: Number(danger.toFixed(3)),
                hp: Math.round(player.health),
                dist: Number(distToTarget.toFixed(2)),
                visible,
                recentlyDamaged,
                needsReload,
                gasEmergency,
                weaponClass,
            });
        }

        const sanitizeGoal = (pos: { x: number; y: number }) => {
            let goal = v2.copy(pos);
            game.map.clampToMapBounds(goal);

            const gas = game.gas;
            const delta = v2.sub(goal, gas.posNew);
            const dist = v2.length(delta);
            const maxDist = Math.max(gas.radNew - 2, 0);
            if (dist > maxDist && maxDist > 0) {
                const dir = v2.normalizeSafe(delta, v2.create(1, 0));
                goal = v2.add(gas.posNew, v2.mul(dir, maxDist));
                game.map.clampToMapBounds(goal);
            }

            if (game.map.isOnWater(goal, 0)) {
                goal = v2.lerp(0.5, goal, game.gas.posNew);
                game.map.clampToMapBounds(goal);
            }

            return goal;
        };

        const rangePoint = (desiredDist: number) => {
            const dirFromTarget = v2.normalizeSafe(
                v2.sub(player.pos, target.pos),
                v2.randomUnit(),
            );
            return sanitizeGoal(v2.add(target.pos, v2.mul(dirFromTarget, desiredDist)));
        };

        const retreatPoint = (retreatDist: number) => {
            const enteringRetreat =
                stateChanged &&
                (state === "seek_cover" ||
                    state === "retreat_reload" ||
                    state === "retreat_heal");
            if (enteringRetreat || timeNow > combat.evadeUntil) {
                combat.evadeAwayFrac = util.random(0.6, 0.8);
                combat.evadePerpSign = Math.random() < 0.5 ? -1 : 1;
                combat.evadeUntil = timeNow + util.random(0.5, 1.0);
            }

            const away = v2.normalizeSafe(
                v2.sub(player.pos, target.pos),
                v2.randomUnit(),
            );
            const perp = v2.perp(away);
            const dir = v2.normalizeSafe(
                v2.add(
                    v2.mul(away, combat.evadeAwayFrac),
                    v2.mul(perp, (1 - combat.evadeAwayFrac) * combat.evadePerpSign),
                ),
                away,
            );

            const raw = v2.add(player.pos, v2.mul(dir, retreatDist));
            const biased = v2.lerp(0.22, raw, game.gas.posNew);
            return sanitizeGoal(biased);
        };

        const coverState =
            state === "seek_cover" ||
            state === "retreat_reload" ||
            state === "retreat_heal";
        const enteringCoverState = stateChanged && coverState;

        const isCoverPosValid = (pos: { x: number; y: number }) => {
            if (gas.isInGas(pos) || gas.isOutSideSafeZone(pos)) return false;
            if (game.map.isOnWater(pos, player.layer)) return false;
            return true;
        };

        const segmentHasLineOfSight = (
            a: { x: number; y: number },
            b: { x: number; y: number },
            height: number,
            hackStairs: boolean,
        ): boolean => {
            const len = v2.distance(a, b);
            if (len <= 0.0001) return true;

            const dir = v2.normalizeSafe(v2.sub(b, a), v2.create(1, 0));
            const aabb = coldet.lineSegmentToAabb(a, b);
            const nearby = game.grid.intersectCollider(aabb);
            const obstacles = nearby.filter(
                (o) => o.__type === ObjectType.Obstacle,
            ) as any[];

            const dist = collisionHelpers.intersectSegmentDist(
                obstacles,
                a,
                dir,
                len,
                height,
                player.layer,
                hackStairs,
            );

            return dist >= len - 0.05;
        };

        const pickCoverPoint = () => {
            if (gasEmergency) return undefined;

            const targetId = perception.targetId;
            if (targetId === undefined) return undefined;

            if (
                !enteringCoverState &&
                timeNow < combat.coverUntil &&
                combat.coverTargetId === targetId
            ) {
                if (!combat.coverPos) return undefined;
                if (isCoverPosValid(combat.coverPos)) return combat.coverPos;
            }

            const considerCandidate = (candidate: { x: number; y: number }) => {
                game.map.clampToMapBounds(candidate);

                if (!isCoverPosValid(candidate)) return;

                const losBlocked = !segmentHasLineOfSight(
                    target.pos,
                    candidate,
                    GameConfig.bullet.height,
                    true,
                );
                if (!losBlocked) return;

                const distFromBot = v2.distance(player.pos, candidate);
                const distFromEnemy = v2.distance(target.pos, candidate);

                const safeEdgeDist = gas.radNew - 2;
                const gasPenalty =
                    Math.max(0, v2.distance(candidate, gas.posNew) - safeEdgeDist) * 10;

                const reachable = segmentHasLineOfSight(
                    player.pos,
                    candidate,
                    0.0,
                    false,
                );
                const reachPenalty = reachable ? 0 : 200;

                const score =
                    1000 -
                    distFromBot * 2 +
                    distFromEnemy * 0.5 -
                    gasPenalty -
                    reachPenalty;

                if (score > bestScore) {
                    bestScore = score;
                    bestPos = v2.copy(candidate);
                }
            };

            let bestPos: { x: number; y: number } | undefined;
            let bestScore = -Infinity;

            const sampleCount = util.randomInt(12, 16);
            const ringCount = Math.max(1, Math.floor(sampleCount * 0.4));
            const randomCount = sampleCount - ringCount;

            const away = v2.normalizeSafe(
                v2.sub(player.pos, target.pos),
                v2.create(1, 0),
            );

            const arc = Math.PI / 2;
            for (let i = 0; i < ringCount; i++) {
                const t = ringCount === 1 ? 0.5 : i / Math.max(ringCount - 1, 1);
                const ang = math.lerp(t, -arc, arc);
                const dir = v2.rotate(away, ang);
                const radius = util.random(10, 14);
                considerCandidate(v2.add(player.pos, v2.mul(dir, radius)));
            }

            for (let i = 0; i < randomCount; i++) {
                const dir = v2.randomUnit();
                const radius = util.random(4, 14);
                considerCandidate(v2.add(player.pos, v2.mul(dir, radius)));
            }

            combat.coverTargetId = targetId;
            combat.coverUntil = timeNow + util.random(0.75, 1.5);

            if (bestPos) {
                combat.coverPos = bestPos;
                return bestPos;
            }

            combat.coverPos = undefined;
            return undefined;
        };

        combat.goalPos = undefined;
        combat.movementStyle = "direct";

        switch (state) {
            case "push":
                combat.goalPos = rangePoint(idealMax);
                combat.movementStyle = "direct";
                break;
            case "back_off":
                combat.goalPos = rangePoint(Math.max(idealMin, 0) + rangeSlack);
                combat.movementStyle = "direct";
                break;
            case "chase_last_seen":
                combat.goalPos = perception.lastSeenPos
                    ? sanitizeGoal(perception.lastSeenPos)
                    : sanitizeGoal(target.pos);
                combat.movementStyle = "direct";
                break;
            case "seek_cover":
                combat.goalPos = pickCoverPoint() ?? retreatPoint(14);
                combat.movementStyle = "direct";
                break;
            case "retreat_reload":
                combat.goalPos = pickCoverPoint() ?? retreatPoint(16);
                combat.movementStyle = "direct";
                break;
            case "retreat_heal":
                combat.goalPos = pickCoverPoint() ?? retreatPoint(18);
                combat.movementStyle = "direct";
                break;
            case "hold_position":
                combat.goalPos = v2.copy(player.pos);
                combat.movementStyle = "anchor";
                break;
            case "strafe":
                combat.goalPos = v2.copy(player.pos);
                combat.movementStyle = "strafe";
                break;
            case "hold_range":
            default:
                combat.goalPos = v2.copy(player.pos);
                combat.movementStyle = "anchor";
                break;
        }
    }
}
