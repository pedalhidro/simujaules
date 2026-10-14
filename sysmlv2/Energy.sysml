package SimujaulesEnergy {
    doc
    /*
     * The v2 leg-energy model (bicycling-energy-model/notas.md, per-edge
     * realisation). Physics is folded ONCE in app.js readCost() into a kJ-unit
     * CostBundle that is shipped identically to every engine (JS worker, graph
     * engine, native/wasm core), which is what keeps them bit-parity.
     * Calcs here use plain Reals in the code's own units (kJ, metres, grades)
     * so they read exactly like energy-worker.js v2Edge(); RiderParameters
     * carries the ISQ-typed user inputs.
     */

    private import ScalarValues::*;
    private import RealFunctions::*;
    private import ISQ::*;
    private import SI::*;

    // ---------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------

    attribute G_SP : Real = 9.7864 {
        doc
        /*
         * Local gravity in m/s^2 (Sao Paulo, IAG-USP absolute gravimetry); NOT the
         * textbook 9.81 (~0.24 % high here). Origin: app.js G_SP near readCost.
         * Hand-copied mirrors: census/census-density.mjs, test-energy-v2.mjs,
         * docs/grid-*.mjs. See requirement EM-01.
         */
    }
    attribute EPS_OFFSET : Real = 0.13 {
        doc /* Empirical descent-recovery offset (CostBundle.epsOffset). */
    }
    attribute KJ : Real = 1000.0 {
        doc /* J per kJ: every CostBundle coefficient is in kJ. */
    }

    // ---------------------------------------------------------------------
    // Inputs and the folded bundle
    // ---------------------------------------------------------------------

    attribute def RiderParameters {
        doc /* User physics inputs (parameters panel; ids in brackets). */
        attribute mass : MassValue = 75 [kg] { doc /* #mass: rider + bike */ }
        attribute crr : Real = 0.008 { doc /* #crr: rolling resistance */ }
        attribute cda : AreaValue = 0.45 [m^2] { doc /* #cda: drag area */ }
        attribute rho : MassDensityValue = 1.1 [kg/m^3] { doc /* #rho: air density at ~750 m asl */ }
        attribute keff : Real = 0.97 { doc /* #keff: drivetrain efficiency, clamped to [0.1, 1] */ }
        attribute pFlat : PowerValue = 80 [W] { doc /* #pflat: cruise power on the flat */ }
        attribute climbThrPct : Real = 2.0 { doc /* #climb-thr: climb grade threshold in % */ }
        attribute kSmooth : Real = 1.0 { doc /* #ksmooth: climb-term scale in [0, 1] */ }
    }

    attribute def CostBundle {
        doc
        /*
         * The engine-facing cost bundle {aRoll, aAero, beta, climbThr, abRatio,
         * epsOffset}. Gravity is already folded in, so engines are gravity-blind.
         */
        attribute aRoll : Real { doc /* kJ per ground metre, always paid: m*g*Crr/keff/1000 */ }
        attribute aAero : Real { doc /* kJ per ground metre, only off climbs: 0.5*rho*CdA*vf^2/keff/1000 */ }
        attribute beta : Real { doc /* kJ per metre of climb: m*g*kSmooth/keff/1000 (~0.76 at defaults) */ }
        attribute climbThr : Real { doc /* grade at/above which aero is dropped (0.02) */ }
        attribute abRatio : Real { doc /* flat-resistance grade Crr + 0.5*rho*CdA*vf^2/(m*g) = alpha/beta */ }
        attribute epsOffset : Real { doc /* 0.13 */ }
    }

    // ---------------------------------------------------------------------
    // Derivation (app.js readCost / flatEqSpeed)
    // ---------------------------------------------------------------------

    constraint def FlatPowerBalance {
        doc
        /*
         * flatEqSpeed(): the flat-equivalent speed vf solves
         * keff*P = (Crr*m*g + 0.5*rho*CdA*vf^2)*vf, found by 60-step bisection
         * on [0, 40] m/s.
         */
        in m : Real; in crr : Real; in cda : Real; in rho : Real;
        in keff : Real; in pFlat : Real; in vf : Real;
        (crr * m * G_SP + 0.5 * rho * cda * vf * vf) * vf == keff * pFlat
    }

    calc def ReadCost {
        doc /* app.js readCost(): fold rider physics into the kJ CostBundle. */
        in m : Real; in crr : Real; in cda : Real; in rho : Real;
        in keff : Real; in vf : Real; in climbThrPct : Real; in kSmooth : Real;
        return bundle : CostBundle {
            :>> aRoll = m * G_SP * crr / keff / KJ;
            :>> aAero = 0.5 * rho * cda * vf * vf / keff / KJ;
            :>> beta = m * G_SP * kSmooth / keff / KJ;
            :>> climbThr = climbThrPct / 100.0;
            :>> abRatio = crr + 0.5 * rho * cda * vf * vf / (m * G_SP);
            :>> epsOffset = EPS_OFFSET;
        }
    }

    // ---------------------------------------------------------------------
    // Per-edge cost (energy-worker.js v2Edge == graph-engine.js stepCost ==
    // main.rs port)
    // ---------------------------------------------------------------------

    calc def DescentRecovery {
        doc /* eps = clamp01(min(1, abRatio*dist/|dh|) - epsOffset): gentle grades recover most, steep none. */
        in c : CostBundle; in dist : Real; in ndh : Real;
        return eps : Real = max(0.0, min(1.0, c.abRatio * dist / ndh) - c.epsOffset);
    }

    calc def V2Edge {
        doc
        /*
         * Energy (kJ) of one directed edge of ground length dist (m) and signed
         * rise dh (m). Uphill/flat: aRoll*d + (grade < climbThr ? aAero*d : 0)
         * + beta*dh. Downhill: max(0, aRoll*d + aAero*d - eps*beta*|dh|). The
         * trailing max(0, .) is provably unreachable (journal Entry 18) and kept
         * only as defensive bit-parity code (EP-14).
         */
        in c : CostBundle; in dist : Real; in dh : Real;
        return e : Real =
            if dh >= 0.0 ?
                c.aRoll * dist + (if dh < c.climbThr * dist ? c.aAero * dist else 0.0) + c.beta * dh
            else
                max(0.0, c.aRoll * dist + c.aAero * dist
                    - DescentRecovery(c, dist, -dh) * c.beta * (-dh));
    }

    constraint def DescentClampUnreachable {
        doc
        /*
         * Journal Entry 18 (1.78 M-combo sweep; min pre-clamp +4.1e-4 kJ): every
         * descent edge's pre-clamp cost is strictly positive, so the clamp in
         * V2Edge never fires and viewing == routing needs no reconciliation.
         * Must be re-proven (verify_v2edge_clamp.mjs) for any formula change.
         */
        in c : CostBundle; in dist : Real; in dh : Real;
        dh < 0.0 implies
            c.aRoll * dist + c.aAero * dist - DescentRecovery(c, dist, -dh) * c.beta * (-dh) > 0.0
    }

    calc def PortalCost {
        doc
        /*
         * buildPortalAdj / build_portals: a bridge deck is ONE directed edge
         * between its abutment cells costed as a flat deck, v2Edge(deckLenM, dh)
         * with dh from the deck endpoint heights (NaN -> DEM height, widened
         * f32 -> f64); the reverse direction uses -dh.
         */
        in c : CostBundle; in deckLenM : Real; in dh : Real;
        return e : Real = V2Edge(c, deckLenM, dh);
    }

    calc def LongEdgeCost {
        doc
        /*
         * longEdgeCost: a long move (nDirs > 8) is PROFILE-INTEGRATED: bilinear
         * heights at 2*max(|dr|,|dc|) sub-steps, V2Edge summed per sub-step,
         * Infinity if any sampled cell is masked. Never costed from endpoint dh.
         * Represented abstractly: the sum over sub-steps is not expanded here.
         */
        in c : CostBundle; in subStepLenM : Real[*]; in subStepDh : Real[*];
        return e : Real;
    }

    // ---------------------------------------------------------------------
    // Terrain preprocessing and KPI correction (outside the engines)
    // ---------------------------------------------------------------------

    attribute def DemSmoothing {
        doc
        /*
         * #dem-smooth: smoothHeightsInPlace, sequential per-axis mask-normalised
         * Gaussian applied in place at DEM load, BEFORE any engine sees heights.
         * auto = sigma 30 m on every source (bicycling-energy-model Entry 74);
         * already-smoothed re-imports are detected via dem.tif ImageDescription.
         */
        attribute sigma : LengthValue = 30 [m];
        attribute auto : Boolean = true;
    }

    calc def KpiThresholdCorrection {
        doc
        /*
         * #kpi-corr: the 8-grid over-estimates energies; c inflates the two
         * accessibility thresholds before counting (default 1.00 = off; measured
         * c* ~1.09-1.12 on the SP DTM). Lives ONLY at the KPI layer (KP-04).
         */
        in threshold : Real; in corr : Real;
        return corrected : Real = threshold * corr;
    }
}
