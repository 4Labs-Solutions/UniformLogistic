import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';

const mocks = {
    'next/cache': 'export const revalidatePath = () => globalThis.purchaseTest.refreshes++;',
    'next/headers': 'export const cookies = async () => ({ get: () => undefined });',
    '@/utils/supabase/server': `export const createClient = async () => globalThis.purchaseTest.client;
        export const createServiceClient = () => { throw new Error('Unexpected privileged client'); };`
};
registerHooks({ resolve(specifier, context, next) {
    if (mocks[specifier]) return { url: `data:text/javascript,${encodeURIComponent(mocks[specifier])}`, shortCircuit: true };
    if (specifier.startsWith('@/')) return next(new URL(`../${specifier.slice(2)}.ts`, import.meta.url).href, context);
    if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
        const target = new URL(specifier, context.parentURL);
        if (!existsSync(target) && existsSync(new URL(`${target.href}.ts`))) return next(`${target.href}.ts`, context);
    }
    return next(specifier, context);
} });
const { markReportPurchasedAction } = await import('../app/(admin)/admin/_stage-actions.ts');

test('only admins can purchase shortages; rejected callers cause no writes or refreshes', async () => {
    for (const user of [null,
        { id: 'production', email: 'produccion-computadoras@uniformlogisticcr.com', app_metadata: { role: 'production' } },
        { id: 'customer', email: 'customer@example.com' },
        { id: 'spoofed', email: 'other@example.com', user_metadata: { role: 'admin' } },
        { id: 'admin', email: 'ulogisticcr@gmail.com' }
    ]) {
        const state = globalThis.purchaseTest = { writes: [], refreshes: 0 };
        state.client = {
            auth: { getUser: async () => ({ data: { user } }) },
            rpc: async () => ({ data: false, error: null }),
            from: (table) => {
                const query = {
                    update: (row) => { state.writes.push({ table, row }); return query; },
                    eq: () => query,
                    select: () => query,
                    maybeSingle: async () => ({ data: { id: 'report' }, error: null }),
                    single: async () => ({ data: { id: 'report' }, error: null }),
                    then: (resolve) => resolve({ data: { id: 'report' }, error: null })
                };
                return query;
            }
        };
        const result = await markReportPurchasedAction('report');
        if (user?.id === 'admin') {
            assert.deepEqual(result, {});
            assert.equal(state.writes.length, 1);
            assert.equal(state.writes[0].table, 'missing_insumo_reports');
            assert.equal(state.writes[0].row.status, 'purchased');
            assert.equal(state.writes[0].row.purchased_by, user.id);
            assert.ok(state.refreshes > 0);
        } else {
            assert.match(result.error, /No autorizado|No autenticado/);
            assert.deepEqual(state.writes, []);
            assert.equal(state.refreshes, 0);
        }
    }
});
