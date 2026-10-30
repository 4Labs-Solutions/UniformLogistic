'use server';

import { revalidatePath } from 'next/cache';
import { createClient, createServiceClient } from '@/utils/supabase/server';
import {
    updateOrderStatus,
    addExtraOrderItem,
    type OrderStatus,
    type ExtraItemInput
} from '@/lib/services/orders';
import {
    createStageNotification,
    acknowledgeStageNotification,
    unacknowledgeStageNotification,
    type Stage
} from '@/lib/services/stage-notifications';
import {
    markStageComplete,
    unmarkStageComplete,
    type StageKey
} from '@/lib/services/stage-completions';
import {
    saveStageItemProgress,
    type ProgressEntry
} from '@/lib/services/stage-item-progress';
import {
    saveCorteFabricReport,
    type FabricUsageEntry
} from '@/lib/services/corte-fabric-reports';
import { fetchStationUser } from '@/lib/services/station-users';
import { isStationAssignedToOrder } from '@/lib/services/station-assignments';
import { isAdminEmail } from '@/lib/admin-acting-company';
import { requireAdmin } from '@/lib/admin-auth';
import {
    createMissingReport,
    fetchAllReports,
    markReportPurchased,
    markReportReceived,
    reopenReport,
    type MissingInsumoReport
} from '@/lib/services/missing-insumos';

// Stage-board status updates revalidate every stage page so an order
// moving from corte → maquila disappears from one board and appears on
// the next on the operator's next refresh.
const STAGE_PATHS = [
    '/admin/orders',
    '/admin/operador',
    '/admin/corte',
    '/admin/maquila',
    '/admin/impresion',
    '/admin/bordado',
    '/admin/empaque',
    '/admin/ploter'
];

export async function updateStageStatusAction(orderUuid: string, status: OrderStatus) {
    const supabase = await createClient();
    await updateOrderStatus(supabase, orderUuid, status);
    for (const p of STAGE_PATHS) revalidatePath(p);
}

// Per the user's spec: the "Finished" button does NOT auto-advance the
// order status — admins still decide when to move it to the next stage.
// Notifying only creates a stage_notification that surfaces on the bell
// in /admin/orders so the admin sees that the stage is done.
export async function notifyStageFinishedAction(
    orderUuid: string,
    stage: Stage,
    message?: string
) {
    const supabase = await createClient();
    const {
        data: { user }
    } = await supabase.auth.getUser();
    if (!user) throw new Error('No autenticado');
    await createStageNotification(supabase, {
        orderId: orderUuid,
        stage,
        message,
        createdBy: user.id
    });
    revalidatePath('/admin/orders');
    for (const p of STAGE_PATHS) revalidatePath(p);
}

export async function acknowledgeStageNotificationAction(notificationId: string) {
    const supabase = await createClient();
    const {
        data: { user }
    } = await supabase.auth.getUser();
    if (!user) throw new Error('No autenticado');
    await acknowledgeStageNotification(supabase, notificationId, user.id);
    revalidatePath('/admin/orders');
}

export async function unacknowledgeStageNotificationAction(notificationId: string) {
    const supabase = await createClient();
    await unacknowledgeStageNotification(supabase, notificationId);
    revalidatePath('/admin/orders');
}

// ─── Per-stage completion (new parallel-stage workflow) ──────────────
// Each operations board marks "this stage is done for this order"
// independently of the others. /admin/orders aggregates the four
// stages into a single completion strip per order.

/**
 * Returns true if the caller is allowed to mutate the (order, stage)
 * completion. Admin can do anything. A station user can only toggle
 * the completion for THEIR assigned stage on orders THEY're assigned
 * to. Anyone else is rejected.
 */
async function authorizeStageMutation(
    supabase: Awaited<ReturnType<typeof createClient>>,
    userId: string,
    userEmail: string | null | undefined,
    orderUuid: string,
    stage: StageKey
): Promise<boolean> {
    if (isAdminEmail(userEmail)) return true;
    const station = await fetchStationUser(supabase, userId);
    if (!station) return false;
    if (!station.isActive) return false;
    if (station.stage !== stage) return false;
    return isStationAssignedToOrder(supabase, userId, orderUuid);
}

export async function markStageCompleteAction(
    orderUuid: string,
    stage: StageKey,
    notes?: string
) {
    const supabase = await createClient();
    const {
        data: { user }
    } = await supabase.auth.getUser();
    if (!user) throw new Error('No autenticado');
    if (!(await authorizeStageMutation(supabase, user.id, user.email, orderUuid, stage))) {
        throw new Error('No autorizado para esta etapa de este pedido.');
    }
    await markStageComplete(supabase, orderUuid, stage, user.id, notes);
    for (const p of STAGE_PATHS) revalidatePath(p);
    revalidatePath('/station');
}

export async function unmarkStageCompleteAction(
    orderUuid: string,
    stage: StageKey
) {
    const supabase = await createClient();
    const {
        data: { user }
    } = await supabase.auth.getUser();
    if (!user) throw new Error('No autenticado');
    if (!(await authorizeStageMutation(supabase, user.id, user.email, orderUuid, stage))) {
        throw new Error('No autorizado para esta etapa de este pedido.');
    }
    await unmarkStageComplete(supabase, orderUuid, stage);
    for (const p of STAGE_PATHS) revalidatePath(p);
    revalidatePath('/station');
}

// ─── Outsourced-work pickup lifecycle ────────────────────────────────
// An external station flags its finished work "listo para recoger"; the
// office later marks it "recogido", which also completes that stage
// in-house (the goods are back and the order can move on).

/**
 * External station flags (or un-flags) an order ready for the office to
 * collect. Caller must be the station user assigned to the order; the
 * privileged write then runs with the service-role client.
 */
export async function setReadyForPickupAction(
    orderUuid: string,
    ready: boolean
): Promise<{ error?: string }> {
    const supabase = await createClient();
    const {
        data: { user }
    } = await supabase.auth.getUser();
    if (!user) return { error: 'No autenticado.' };
    const station = await fetchStationUser(supabase, user.id);
    if (!station || !station.isActive) return { error: 'No autorizado.' };
    if (!(await isStationAssignedToOrder(supabase, user.id, orderUuid))) {
        return { error: 'No autorizado para este pedido.' };
    }
    const service = createServiceClient();
    const { error } = await service
        .from('station_assignments')
        .update({ ready_for_pickup_at: ready ? new Date().toISOString() : null })
        .eq('order_id', orderUuid)
        .eq('station_user_id', user.id);
    if (error) return { error: error.message };

    // The external station controls its own stage completion: flagging an
    // order "listo para recoger" completes the stage; undoing reopens it.
    if (ready) await markStageComplete(supabase, orderUuid, station.stage, user.id);
    else await unmarkStageComplete(supabase, orderUuid, station.stage);

    for (const p of STAGE_PATHS) revalidatePath(p);
    revalidatePath('/station');
    return {};
}

/**
 * Office records that an outsourced order was collected from
 * `stationUserId`. Admin-only. Pickup is tracked independently of stage
 * completion — the admin marks the maquila stage complete separately.
 */
export async function markPickedUpAction(
    orderUuid: string,
    stationUserId: string,
    pickedUp: boolean
): Promise<{ error?: string }> {
    const supabase = await createClient();
    const {
        data: { user }
    } = await supabase.auth.getUser();
    if (!user) return { error: 'No autenticado.' };
    if (!isAdminEmail(user.email)) return { error: 'No autorizado.' };

    const service = createServiceClient();
    const { error } = await service
        .from('station_assignments')
        .update({
            picked_up_at: pickedUp ? new Date().toISOString() : null,
            picked_up_by: pickedUp ? user.id : null
        })
        .eq('order_id', orderUuid)
        .eq('station_user_id', stationUserId);
    if (error) return { error: error.message };

    revalidatePath('/admin/maquila');
    revalidatePath('/station');
    return {};
}

// ─── Partial stage progress (per-item) ───────────────────────────────
// Some stages (Bordado) finish an order in batches. The operator records
// how many pieces of each line are done. We persist those counts and
// then reconcile the binary completion: when every line is at its full
// quantity the stage is marked complete; if any line drops below full
// while the stage was complete, it's un-marked. Authorization mirrors
// the completion toggle (admin OR the assigned station for this stage).
export async function saveStageProgressAction(
    orderUuid: string,
    stage: StageKey,
    entries: ProgressEntry[]
): Promise<{ error?: string; completed?: boolean }> {
    const supabase = await createClient();
    const {
        data: { user }
    } = await supabase.auth.getUser();
    if (!user) return { error: 'No autenticado.' };
    if (!(await authorizeStageMutation(supabase, user.id, user.email, orderUuid, stage))) {
        return { error: 'No autorizado para esta etapa de este pedido.' };
    }

    try {
        await saveStageItemProgress(supabase, orderUuid, stage, entries, user.id);

        // Maquila completion is owned solely by the station's explicit
        // "listo para recoger" signal, so recording progress there is
        // reporting only — it must never (un)complete the stage. Every
        // other stage reconciles completion from the line counts.
        if (stage === 'maquila') {
            for (const p of STAGE_PATHS) revalidatePath(p);
            revalidatePath('/station');
            return {};
        }

        // Reconcile the binary completion against the true line
        // quantities (read from the DB, not the client payload).
        const { data: items, error } = await supabase
            .from('order_items')
            .select('id, quantity')
            .eq('order_id', orderUuid);
        if (error) throw error;

        const doneById = new Map(entries.map((e) => [e.orderItemId, Math.max(0, Math.round(e.qtyDone))]));
        const rows = (items || []) as { id: string; quantity: number }[];
        const allFull =
            rows.length > 0 &&
            rows.every((it) => (doneById.get(it.id) ?? 0) >= it.quantity);

        if (allFull) {
            await markStageComplete(supabase, orderUuid, stage, user.id);
        } else {
            // Not everything is done — make sure a stale "complete" flag
            // doesn't linger (e.g. operator corrected a count downward).
            await unmarkStageComplete(supabase, orderUuid, stage);
        }

        for (const p of STAGE_PATHS) revalidatePath(p);
        revalidatePath('/station');
        return { completed: allFull };
    } catch (err) {
        return {
            error: err instanceof Error ? err.message : 'No se pudo guardar el avance.'
        };
    }
}

// ─── Corte: add an extra line item ───────────────────────────────────
// The corte operator (admin OR the assigned corte station) can add an
// extra piece beyond the placed order — a replacement, a sample, a
// forgotten size. Stored as a normal order_items row flagged
// is_extra=true. Authorization mirrors the stage-completion check:
// admin OR an active corte station assigned to this order.
export async function addCorteExtraItemAction(
    orderUuid: string,
    input: ExtraItemInput
): Promise<{ error?: string; itemId?: string }> {
    const supabase = await createClient();
    const {
        data: { user }
    } = await supabase.auth.getUser();
    if (!user) return { error: 'No autenticado.' };
    if (!(await authorizeStageMutation(supabase, user.id, user.email, orderUuid, 'corte'))) {
        return { error: 'No autorizado para esta orden.' };
    }
    if (!input.productName.trim()) return { error: 'El producto es obligatorio.' };
    if (!Number.isFinite(input.quantity) || input.quantity <= 0) {
        return { error: 'La cantidad debe ser mayor a cero.' };
    }
    try {
        const itemId = await addExtraOrderItem(supabase, orderUuid, input, user.id);
        for (const p of STAGE_PATHS) revalidatePath(p);
        revalidatePath('/station');
        return { itemId };
    } catch (err) {
        return {
            error: err instanceof Error ? err.message : 'No se pudo agregar el extra.'
        };
    }
}

// ─── Corte: fabric consumption report ────────────────────────────────
// The corte agent records how much tela the order actually ate, one
// figure per tela. `expectedQty` rides along from the client as the BOM
// estimate shown at the time of reporting — snapshotting it keeps the
// variance honest if the product's BOM is edited later. Same
// authorization as every other corte mutation.
export async function saveCorteFabricReportAction(
    orderUuid: string,
    entries: FabricUsageEntry[]
): Promise<{ error?: string }> {
    const supabase = await createClient();
    const {
        data: { user }
    } = await supabase.auth.getUser();
    if (!user) return { error: 'No autenticado.' };
    if (!(await authorizeStageMutation(supabase, user.id, user.email, orderUuid, 'corte'))) {
        return { error: 'No autorizado para esta orden.' };
    }
    if (entries.some((e) => !Number.isFinite(e.qtyUsed) || e.qtyUsed < 0)) {
        return { error: 'La cantidad de tela no puede ser negativa.' };
    }
    try {
        await saveCorteFabricReport(supabase, orderUuid, entries, user.id);
        revalidatePath('/admin/corte');
        revalidatePath('/station');
        return {};
    } catch (err) {
        return {
            error: err instanceof Error ? err.message : 'No se pudo guardar el reporte de tela.'
        };
    }
}

// ─── Missing-item reports (all operation boards) ────────────────────
// Any operation module can flag a shortage against an order. Unlike the
// operator/maquila per-insumo report (which knows the BOM required qty),
// this is a free-text item + missing quantity, so required_qty defaults
// to 0 at the DB level. All reports — insumo-based or free-text — land
// in the same missing_insumo_reports table and share the history view.
export async function reportMissingItemAction(
    orderUuid: string,
    itemName: string,
    missingQty: number,
    notes?: string,
    stage?: string
): Promise<{ error?: string }> {
    const supabase = await createClient();
    const {
        data: { user }
    } = await supabase.auth.getUser();
    if (!user) return { error: 'No autenticado.' };
    if (!itemName.trim()) return { error: 'Indicá qué artículo falta.' };
    if (!Number.isFinite(missingQty) || missingQty <= 0) {
        return { error: 'La cantidad faltante debe ser mayor a cero.' };
    }
    try {
        await createMissingReport(supabase, {
            order_id: orderUuid,
            insumo_name: itemName.trim(),
            required_qty: 0,
            missing_qty: missingQty,
            reported_by: user.id,
            notes: notes?.trim() || undefined,
            stage: stage?.trim() || undefined
        });
        for (const p of STAGE_PATHS) revalidatePath(p);
        return {};
    } catch (err) {
        return {
            error: err instanceof Error ? err.message : 'No se pudo enviar el reporte.'
        };
    }
}

// Read model for the history panel. Lazily called when the operator
// opens the "Historial de reportes" modal so we don't load reports into
// every board on mount.
export async function fetchMissingReportsAction(): Promise<MissingInsumoReport[]> {
    const supabase = await createClient();
    const {
        data: { user }
    } = await supabase.auth.getUser();
    if (!user) throw new Error('No autenticado');
    return fetchAllReports(supabase);
}

// Admin buys the insumo (open → purchased). Lives here so both the
// pedidos notifications panel and any board can call it.
export async function markReportPurchasedAction(
    reportId: string
): Promise<{ error?: string }> {
    try {
        const { supabase, user } = await requireAdmin();
        await markReportPurchased(supabase, reportId, user.id);
        for (const p of STAGE_PATHS) revalidatePath(p);
        return {};
    } catch (err) {
        return {
            error: err instanceof Error ? err.message : 'No se pudo marcar como comprado.'
        };
    }
}

// The raising board received the insumo (purchased → received → closed).
export async function markReportReceivedAction(
    reportId: string
): Promise<{ error?: string }> {
    const supabase = await createClient();
    const {
        data: { user }
    } = await supabase.auth.getUser();
    if (!user) return { error: 'No autenticado.' };
    try {
        await markReportReceived(supabase, reportId, user.id);
        for (const p of STAGE_PATHS) revalidatePath(p);
        return {};
    } catch (err) {
        return {
            error: err instanceof Error ? err.message : 'No se pudo marcar como recibido.'
        };
    }
}

// Undo — send a report back to the open queue.
export async function reopenMissingReportAction(
    reportId: string
): Promise<{ error?: string }> {
    const supabase = await createClient();
    const {
        data: { user }
    } = await supabase.auth.getUser();
    if (!user) return { error: 'No autenticado.' };
    try {
        await reopenReport(supabase, reportId);
        for (const p of STAGE_PATHS) revalidatePath(p);
        return {};
    } catch (err) {
        return {
            error: err instanceof Error ? err.message : 'No se pudo reabrir el reporte.'
        };
    }
}
