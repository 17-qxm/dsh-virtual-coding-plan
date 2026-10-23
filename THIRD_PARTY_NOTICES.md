# Third-party notices

## dsh-whale-widget

`pricing.mjs` ports the pricing table, the peak/valley rule, the legal-holiday
list and the money-unit helpers from **dsh-whale-widget v0.4.2**.

- Source: https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget
- Files ported: `lib/index.js` (`PEAK_HOURS`, `BASE_PRICE`, `PRO_PRICE`,
  `PRICING`, `priceFor`, `isPeakTime`, `nextPeakChangeAt`, `HOLIDAY_VALLEY`,
  `WEEKEND_VALLEY_FROM_SEC`, `HOLIDAY_VALLEY_FROM_SEC`) and
  `lib/accounting.mjs` (`SCALE`, `moneyUnits`, `sumMoney`).
- What changed: functions are exported, wrapped in a pure module with no IO and
  no module-level mutable state, and renamed where noted in that file's comments.
  The pricing semantics are unchanged on purpose so this plugin's spend
  reconciles with the balance widget's number for the same turn.

```
MIT License

Copyright (c) 2026 MeteorNOX

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
