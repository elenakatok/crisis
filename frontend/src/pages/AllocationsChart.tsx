import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts'
import type { ChartPoint } from '../api'

// The deck's "Allocations" chart — a composed DUAL-AXIS chart:
//   • stacked bars = allocation split per period (Seller 1 + Seller 2 units, sum 100),
//     LEFT axis 0–100 "Units";
//   • two lines = Seller 1 / Seller 2 price per period, RIGHT axis "ECU", auto-scaled.
// Orange family = Seller 1, green family = Seller 2; bars lighter than the lines.

const S1_BAR = '#F2C488', S1_LINE = '#D2691E'   // orange (units lighter than price)
const S2_BAR = '#AEDDB1', S2_LINE = '#2E8B57'   // green

// Bars are declared before the lines so the price lines render ON TOP of the stacked bars.
// Legend names come from each series' `name` (Seller 1, Seller 2, Seller 1 Prices, Seller 2 Prices).

export default function AllocationsChart({ data, testid }: { data: ChartPoint[]; testid?: string }) {
  return (
    <div data-testid={testid ?? 'crisis-alloc-chart'}>
      <h4 style={{ margin: '0 0 0.5rem', textAlign: 'center', fontWeight: 600 }}>Allocations</h4>
      <ResponsiveContainer width="100%" height={340}>
        <ComposedChart data={data} margin={{ top: 8, right: 16, bottom: 24, left: 8 }}>
          <CartesianGrid stroke="#eee" />
          <XAxis dataKey="period" label={{ value: 'Period', position: 'insideBottom', offset: -12 }} />
          <YAxis yAxisId="left" domain={[0, 100]} label={{ value: 'Units', angle: -90, position: 'insideLeft' }} />
          <YAxis yAxisId="right" orientation="right" domain={['auto', 'auto']} label={{ value: 'ECU', angle: 90, position: 'insideRight' }} />
          <Tooltip />
          <Legend />
          {/* bars first → lines render on top */}
          <Bar yAxisId="left" dataKey="s1Units" stackId="alloc" name="Seller 1" fill={S1_BAR} />
          <Bar yAxisId="left" dataKey="s2Units" stackId="alloc" name="Seller 2" fill={S2_BAR} />
          <Line yAxisId="right" type="monotone" dataKey="s1Price" name="Seller 1 Prices" stroke={S1_LINE} strokeWidth={2} dot={{ r: 3 }} />
          <Line yAxisId="right" type="monotone" dataKey="s2Price" name="Seller 2 Prices" stroke={S2_LINE} strokeWidth={2} dot={{ r: 3 }} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}
