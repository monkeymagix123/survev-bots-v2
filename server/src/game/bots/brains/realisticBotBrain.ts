import { GameConfig } from "../../../../../shared/gameConfig";
import { ObjectType } from "../../../../../shared/net/objectSerializeFns";
import { coldet } from "../../../../../shared/utils/coldet";
import { collisionHelpers } from "../../../../../shared/utils/collisionHelpers";
import { math } from "../../../../../shared/utils/math";
import { util } from "../../../../../shared/utils/util";
import { v2 } from "../../../../../shared/utils/v2";
import { Config } from "../../../config";
import type { BotBrainType } from "../botBrain";
import {
    getBotTacticalSnapshot,
    getBotReloadSnapshot,
} from "../botDecisionSupport";
import { logBotCombat } from "../botCombatLogger";
import { logBotStability } from "../botStabilityLogger";
import type { BotBrain, BotBrainContext } from "./botBrainLogic";
import { BotTuning } from "../botTuning";

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
            brainProfile,
            perception,
            navigation,
            lootScorer,
            objectInteractionScorer,
            combat,
            aim,
            weaponLogic,
        } = ctx;

        const scan = perception.scanForTarget(game, player, timeNow, this.type);
        const recentlyDamaged =
            timeNow - combat.lastDamagedTime < BotTuning.combat.recentlyDamagedWindowSec;

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
        const prevObjectTargetId = combat.objectTargetId;
        const prevObjectInteractionMode = combat.objectInteractionMode;
        const prevObjectGoal = combat.goalPos ? v2.copy(combat.goalPos) : undefined;
        const gas = game.gas;
        const gasEmergency = gas.isInGas(player.pos) || gas.isOutSideSafeZone(player.pos);

        const sanitizeGoal = (pos: { x: number; y: number }) => {
            let goal = v2.copy(pos);
            game.map.clampToMapBounds(goal);

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

        if (!perception.targetId) {
            const threat = perception.threat;
            navigation.ensureWaypoint(game, player);
            const idleLoot =
                !gasEmergency &&
                !threat.anyHostileVisible &&
                !threat.hasRecentEnemy &&
                threat.nearestNearbyHostileDist > BotTuning.combat.enemyCloseDist
                    ? lootScorer.chooseLoot({
                          game,
                          player,
                          timeNow,
                          mode: "idle",
                          brainType: this.type,
                      })
                    : undefined;
            const idleObject =
                !gasEmergency &&
                !threat.anyHostileVisible &&
                !threat.hasRecentEnemy &&
                threat.nearestNearbyHostileDist > BotTuning.combat.enemyCloseDist
                    ? objectInteractionScorer.chooseObject({
                          game,
                          player,
                          timeNow,
                          mode: "idle",
                          brainType: this.type,
                          state: combat.state,
                          baseGoal: idleLoot?.pos ?? navigation.waypoint,
                      })
                    : undefined;

            if (idleObject && (idleObject.mode === "use" || !idleLoot)) {
                combat.setState("interact_object", timeNow, idleObject.reason);
                if (prevState !== combat.state) {
                    combat.stateLockUntil =
                        timeNow + BotTuning.objectInteract.stateCommitSec;
                }
                combat.goalPos = sanitizeGoal(idleObject.pos);
                combat.movementStyle = "direct";
                combat.lootTargetId = undefined;
                combat.lootWeaponSlot = undefined;
                combat.objectTargetId = idleObject.obstacleId;
                combat.objectInteractionMode = idleObject.mode;
            } else if (idleLoot) {
                combat.setState("loot", timeNow, idleLoot.reason);
                combat.goalPos = sanitizeGoal(idleLoot.pos);
                combat.movementStyle = "direct";
                combat.lootTargetId = idleLoot.lootId;
                combat.lootWeaponSlot = idleLoot.weaponSlot;
                combat.objectTargetId = undefined;
                combat.objectInteractionMode = undefined;
            } else {
                combat.setState("wander", timeNow, "no_target");
                combat.goalPos = undefined;
                combat.movementStyle = "direct";
                combat.lootTargetId = undefined;
                combat.lootWeaponSlot = undefined;
                combat.objectTargetId = undefined;
                combat.objectInteractionMode = undefined;
            }

            if (Config.bots.debugCombat && prevState !== combat.state) {
                const { gunDef, weaponClass } = weaponLogic.getWeaponInfo(player);
                const activeWeapon = player.weapons[player.curWeapIdx];
                const ammoType = gunDef?.ammo;
                const inventory = player.inventory as Record<string, number>;
                const spareAmmo = ammoType ? (inventory[ammoType] ?? 0) : 0;
                const needsReload =
                    player.isReloading() ||
                    (!!gunDef && activeWeapon.ammo === 0 && spareAmmo > 0);

                logBotCombat({
                    botId: player.__id,
                    brainType: this.type,
                    state: combat.state,
                    stateReason: combat.stateReason,
                    danger: 0,
                    hp: Math.round(player.health),
                    dist: undefined,
                    visible: false,
                    recentlyDamaged,
                    needsReload,
                    gasEmergency,
                    weaponClass,
                    targetId: undefined,
                    goalX: combat.goalPos ? Number(combat.goalPos.x.toFixed(2)) : undefined,
                    goalY: combat.goalPos ? Number(combat.goalPos.y.toFixed(2)) : undefined,
                    movementStyle: combat.movementStyle,
                    lootTargetId: combat.lootTargetId,
                    objectTargetId: combat.objectTargetId,
                    objectInteractionMode: combat.objectInteractionMode,
                });
            }
            return;
        }

        // ── Combat state selection (movement-only) ──

        const target = scan.target!;
        const distToTarget = v2.distance(player.pos, target.pos);

        const { gunDef, weaponClass, profile } = weaponLogic.getWeaponInfo(player);

        const idealMin = profile?.idealMin ?? 0;
        const idealMax = profile?.idealMax ?? 18;
        const engageMax = profile?.engageMax ?? idealMax;
        const rangeSlack = brainProfile.rangeSlack;
        const rangeHysteresis = BotTuning.combat.stateHysteresisDist;

        const lowHp = player.health < BotTuning.heal.lowHp;
        const visible = perception.targetVisible;
        const threat = perception.threat;
        const { isReloading, needsReload } = getBotReloadSnapshot(player, gunDef);
        const tactical = getBotTacticalSnapshot({
            targetVisible: visible,
            hasTarget: true,
            distToTarget,
            lowHp,
            needsReload,
            isReloading,
            recentlyDamaged,
            gasEmergency,
            nearestNearbyHostileDist: threat.nearestNearbyHostileDist,
            nearbyHostileCount: threat.nearbyHostileCount,
            targetHasShownGun: perception.targetHasShownGun,
            targetAppearsUnarmed: perception.targetAppearsUnarmed,
            targetRecentlyFired: perception.targetRecentlyFired,
        });
        const { enemyVeryClose, enemyClose } = tactical;
        const danger = tactical.danger;

        const lastSeenFresh =
            !visible &&
            !!perception.lastSeenPos &&
            timeNow - perception.lastSeenTime <= brainProfile.chaseTtlSec;
        const opportunisticLoot =
            !visible &&
            !gasEmergency &&
            !lowHp &&
            !needsReload &&
            !recentlyDamaged &&
            !threat.hasRecentEnemy &&
            danger <= BotTuning.loot.opportunisticDangerMax &&
            threat.nearestNearbyHostileDist > BotTuning.combat.enemyCloseDist
                ? lootScorer.chooseLoot({
                      game,
                      player,
                      timeNow,
                      mode: "opportunistic",
                      brainType: this.type,
                  })
                : undefined;
        const opportunisticObject =
            !visible &&
            !gasEmergency &&
            !lowHp &&
            !needsReload &&
            !recentlyDamaged &&
            !threat.hasRecentEnemy &&
            danger <= BotTuning.objectInteract.opportunisticDangerMax &&
            threat.nearestNearbyHostileDist > BotTuning.combat.enemyCloseDist
                ? objectInteractionScorer.chooseObject({
                      game,
                      player,
                      timeNow,
                      mode: "opportunistic",
                      brainType: this.type,
                      state: combat.state,
                      baseGoal: opportunisticLoot?.pos ?? perception.lastSeenPos,
                  })
                : undefined;

        type State = typeof combat.state;

        let state: State = "hold_range";
        let reason = "default";

        const newDamageSinceLastDodge =
            combat.lastDamagedTime >
            combat.damageDodgeUntil - BotTuning.combat.damageDodgeDurationSec;
        if (recentlyDamaged && newDamageSinceLastDodge) {
            const alreadyDodging = timeNow < combat.damageDodgeUntil;
            combat.damageDodgeUntil = timeNow + BotTuning.combat.damageDodgeDurationSec;
            if (!alreadyDodging) {
                combat.damageDodgeSign = Math.random() < 0.5 ? -1 : 1;
            }
        }
        const damageDodging = timeNow < combat.damageDodgeUntil;
        const backOffThreshold =
            idealMin - rangeSlack + brainProfile.backOffExtraDist;
        const pushThreshold =
            (weaponClass === "ar" || weaponClass === "lmg" || weaponClass === "precision"
                ? engageMax
                : idealMax) +
            rangeSlack +
            brainProfile.pushExtraDist;
        const shouldBackOff =
            distToTarget <
            backOffThreshold +
                (prevState === "back_off" ? rangeHysteresis : 0);
        const shouldPush =
            distToTarget >
            pushThreshold -
                (prevState === "push" ? rangeHysteresis : 0);

        if (lowHp && danger >= brainProfile.retreatDangerMin) {
            state = "retreat_heal";
            reason = "low_hp";
        } else if (needsReload && danger >= brainProfile.retreatDangerMin) {
            state = "retreat_reload";
            reason = "reload_under_threat";
        } else if (needsReload) {
            if (shouldBackOff) {
                state = "back_off";
                reason = "reload_too_close";
            } else {
                state = "hold_range";
                reason = "reload_hold";
            }
        } else if (damageDodging && !lowHp && !needsReload && !gasEmergency) {
            if (shouldBackOff) {
                state = "back_off";
                reason = "too_close";
            } else {
                state = "strafe";
                reason = "damage_dodge";
            }
        } else if ((lowHp || needsReload) && danger >= brainProfile.highDangerMin) {
            state = "seek_cover";
            reason = "high_danger";
        } else if (opportunisticObject && (opportunisticObject.mode === "use" || !opportunisticLoot)) {
            state = "interact_object";
            reason = opportunisticObject.reason;
        } else if (opportunisticLoot) {
            state = "loot";
            reason = opportunisticLoot.reason;
        } else if (!visible) {
            state = "chase_last_seen";
            reason = perception.lastSeenPos ? "lost_los" : "reposition_blocked_los";
        } else if (lastSeenFresh) {
            state = "chase_last_seen";
            reason = "lost_los";
        } else if (shouldBackOff) {
            state = "back_off";
            reason = "too_close";
        } else if (shouldPush) {
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
            if (
                brainProfile.mistakeChance > 0 &&
                Math.random() < brainProfile.mistakeChance
            ) {
                state = "hold_range";
                reason = "mistake_hold_range";
            }
        }

        const retreatState =
            state === "seek_cover" ||
            state === "retreat_reload" ||
            state === "retreat_heal";
        const prevRetreatState =
            prevState === "seek_cover" ||
            prevState === "retreat_reload" ||
            prevState === "retreat_heal";
        const stateLocked = timeNow < combat.stateLockUntil;

        if (stateLocked) {
            if (
                prevRetreatState &&
                !retreatState &&
                !gasEmergency &&
                perception.targetId !== undefined
            ) {
                state = prevState;
                reason = combat.stateReason;
            } else if (
                prevState === "chase_last_seen" &&
                !visible &&
                state !== "loot" &&
                !retreatState
            ) {
                state = prevState;
                reason = combat.stateReason;
            } else if (
                prevState === "loot" &&
                !visible &&
                !threat.anyHostileVisible &&
                !threat.hasRecentEnemy &&
                combat.lootTargetId !== undefined &&
                state !== "seek_cover" &&
                state !== "retreat_reload" &&
                state !== "retreat_heal"
            ) {
                state = prevState;
                reason = combat.stateReason;
            } else if (
                prevState === "interact_object" &&
                !visible &&
                !threat.anyHostileVisible &&
                !threat.hasRecentEnemy &&
                combat.objectTargetId !== undefined &&
                state !== "seek_cover" &&
                state !== "retreat_reload" &&
                state !== "retreat_heal"
            ) {
                state = prevState;
                reason = combat.stateReason;
            }
        }

        const stateChanged = prevState !== state;
        combat.setState(state, timeNow, reason);
        if (stateChanged) {
            switch (state) {
                case "seek_cover":
                case "retreat_reload":
                case "retreat_heal":
                    combat.stateLockUntil =
                        timeNow + BotTuning.combat.retreatStateCommitSec;
                    break;
                case "chase_last_seen":
                    combat.stateLockUntil =
                        timeNow + BotTuning.combat.chaseStateCommitSec;
                    break;
                case "loot":
                    combat.stateLockUntil =
                        timeNow + BotTuning.combat.lootStateCommitSec;
                    break;
                case "interact_object":
                    combat.stateLockUntil =
                        timeNow + BotTuning.objectInteract.stateCommitSec;
                    break;
                default:
                    combat.stateLockUntil = timeNow;
                    break;
            }
        }

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

            const candidates: Array<{ pos: { x: number; y: number }; score: number }> = [];

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
                    Math.max(0, v2.distance(candidate, gas.posNew) - safeEdgeDist);

                const reachable = segmentHasLineOfSight(
                    player.pos,
                    candidate,
                    0.0,
                    false,
                );
                const reachPenalty = reachable ? 0 : brainProfile.coverReachPenalty;

                const score =
                    1000 -
                    distFromBot * brainProfile.coverBotDistWeight +
                    distFromEnemy * brainProfile.coverEnemyDistWeight -
                    gasPenalty * brainProfile.coverGasPenalty -
                    reachPenalty;
                candidates.push({ pos: v2.copy(candidate), score });
            };

            const ringCount = util.randomInt(
                brainProfile.coverRingSamplesMin,
                brainProfile.coverRingSamplesMax,
            );
            const randomCount = util.randomInt(
                brainProfile.coverRandomSamplesMin,
                brainProfile.coverRandomSamplesMax,
            );

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

            candidates.sort((a, b) => b.score - a.score);

            combat.coverTargetId = targetId;
            combat.coverUntil = timeNow + util.random(0.75, 1.5);

            if (candidates.length > 0) {
                if (Math.random() < brainProfile.coverFallbackChance) {
                    combat.coverPos = undefined;
                    return undefined;
                }

                const choiceIdx =
                    candidates.length > 1 &&
                    brainProfile.coverImperfectChoiceChance > 0 &&
                    Math.random() < brainProfile.coverImperfectChoiceChance
                        ? 1
                        : 0;

                combat.coverPos = candidates[choiceIdx].pos;
                return combat.coverPos;
            }

            combat.coverPos = undefined;
            return undefined;
        };

        combat.goalPos = undefined;
        combat.movementStyle = "direct";
        combat.lootTargetId = undefined;
        combat.lootWeaponSlot = undefined;
        combat.objectTargetId = undefined;
        combat.objectInteractionMode = undefined;

        switch (state) {
            case "interact_object":
                if (opportunisticObject) {
                    combat.goalPos = sanitizeGoal(opportunisticObject.pos);
                    combat.objectTargetId = opportunisticObject.obstacleId;
                    combat.objectInteractionMode = opportunisticObject.mode;
                } else if (
                    prevState === "interact_object" &&
                    prevObjectTargetId !== undefined &&
                    prevObjectGoal &&
                    prevObjectInteractionMode !== undefined
                ) {
                    combat.goalPos = sanitizeGoal(prevObjectGoal);
                    combat.objectTargetId = prevObjectTargetId;
                    combat.objectInteractionMode = prevObjectInteractionMode;
                } else {
                    combat.goalPos = v2.copy(player.pos);
                    combat.movementStyle = "anchor";
                }
                if (combat.goalPos) {
                    combat.movementStyle = "direct";
                }
                break;
            case "loot":
                if (opportunisticLoot) {
                    combat.goalPos = sanitizeGoal(opportunisticLoot.pos);
                    combat.movementStyle = "direct";
                    combat.lootTargetId = opportunisticLoot.lootId;
                    combat.lootWeaponSlot = opportunisticLoot.weaponSlot;
                } else {
                    combat.goalPos = v2.copy(player.pos);
                    combat.movementStyle = "anchor";
                }
                break;
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

        if (Config.bots.debugCombat && stateChanged) {
            logBotCombat({
                botId: player.__id,
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
                targetId: target.__id,
                targetX: Number(target.pos.x.toFixed(2)),
                targetY: Number(target.pos.y.toFixed(2)),
                goalX: combat.goalPos ? Number(combat.goalPos.x.toFixed(2)) : undefined,
                goalY: combat.goalPos ? Number(combat.goalPos.y.toFixed(2)) : undefined,
                movementStyle: combat.movementStyle,
                lootTargetId: combat.lootTargetId,
                objectTargetId: combat.objectTargetId,
                objectInteractionMode: combat.objectInteractionMode,
            });
        }

        if (stateChanged) {
            logBotStability("state_change", {
                brainType: this.type,
                botId: player.__id,
                state,
                reason,
                previousState: prevState,
                hp: Math.round(player.health),
                danger: Number(danger.toFixed(3)),
                distToTarget: Number(distToTarget.toFixed(2)),
                visible,
                gasEmergency,
                weaponClass,
                targetId: target.__id,
                targetX: Number(target.pos.x.toFixed(2)),
                targetY: Number(target.pos.y.toFixed(2)),
                goalX: combat.goalPos ? Number(combat.goalPos.x.toFixed(2)) : undefined,
                goalY: combat.goalPos ? Number(combat.goalPos.y.toFixed(2)) : undefined,
                movementStyle: combat.movementStyle,
                lootTargetId: combat.lootTargetId,
                objectTargetId: combat.objectTargetId,
                objectInteractionMode: combat.objectInteractionMode,
            });
        }
    }
}
