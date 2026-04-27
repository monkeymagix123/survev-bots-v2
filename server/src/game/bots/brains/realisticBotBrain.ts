import type { BotBrainType } from "../botBrain";
import type { BotBrain, BotBrainContext } from "./botBrainLogic";
import { math } from "../../../../../shared/utils/math";
import { v2 } from "../../../../../shared/utils/v2";

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
        const { game, player, timeNow, perception, navigation, combat, aim, weaponLogic } =
            ctx;

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

        if (!perception.targetId) {
            combat.setState("wander", timeNow, "no_target");
            combat.goalPos = undefined;
            combat.movementStyle = "direct";
            navigation.ensureWaypoint(game, player);
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
        const recentlyDamaged = timeNow - combat.lastDamagedTime < 1.0;
        const visible = perception.targetVisible;

        let danger = 0;
        if (visible) danger += 0.4;
        danger += clamp01(1 - distToTarget / 20) * 0.2;
        if (lowHp) danger += 0.25;
        if (recentlyDamaged) danger += 0.3;
        danger = clamp01(danger);

        const activeWeapon = player.weapons[player.curWeapIdx];
        const ammoType = gunDef?.ammo;
        const spareAmmo = ammoType ? player.inventory[ammoType] : 0;
        const needsReload =
            player.isReloading() ||
            (!!gunDef && activeWeapon.ammo === 0 && spareAmmo > 0);

        const lastSeenFresh =
            !visible &&
            !!perception.lastSeenPos &&
            timeNow - perception.lastSeenTime <= tuning.chaseTtlSec;

        type State = typeof combat.state;

        let state: State = "hold_range";
        let reason = "default";

        if (lowHp && danger >= tuning.retreatDangerMin) {
            state = "retreat_heal";
            reason = "low_hp";
        } else if (needsReload && danger >= tuning.retreatDangerMin) {
            state = "retreat_reload";
            reason = "reload_under_threat";
        } else if (
            (recentlyDamaged || visible) &&
            (lowHp || needsReload || danger >= tuning.highDangerMin)
        ) {
            state = "seek_cover";
            reason = recentlyDamaged ? "recent_damage" : "exposed";
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

        combat.setState(state, timeNow, reason);

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
            const away = v2.normalizeSafe(
                v2.sub(player.pos, target.pos),
                v2.randomUnit(),
            );
            const raw = v2.add(player.pos, v2.mul(away, retreatDist));
            const biased = v2.lerp(0.25, raw, game.gas.posNew);
            return sanitizeGoal(biased);
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
                combat.goalPos = retreatPoint(14);
                combat.movementStyle = "direct";
                break;
            case "retreat_reload":
                combat.goalPos = retreatPoint(16);
                combat.movementStyle = "direct";
                break;
            case "retreat_heal":
                combat.goalPos = retreatPoint(18);
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
