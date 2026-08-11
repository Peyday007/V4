import { registerDemandConnector } from '../connector';
import { MunicipalOpenDataConnector } from './municipalOpenData';
import { InboundIntakeConnector } from './inboundIntake';
import { SamGovDemandConnector } from './samGovDemand';

/**
 * Demand connector registry.
 *
 * Registration is explicit and idempotent so a serverless invocation that
 * imports this twice does not double-register, and so the set of sources that
 * can produce demand is visible in one file rather than discovered by grep.
 *
 * Note what is absent: Google Places and the CMS registry. Both are useful for
 * resolving and enriching an account once an event names one, and neither can
 * produce an event, so neither is a demand connector. That absence is the
 * architectural statement — a source cannot accidentally become a demand
 * source by being enabled.
 */

let registered = false;

export function ensureDemandConnectorsRegistered(): void {
  if (registered) return;
  registerDemandConnector(new MunicipalOpenDataConnector());
  registerDemandConnector(new InboundIntakeConnector());
  registerDemandConnector(new SamGovDemandConnector());
  registered = true;
}

export { MunicipalOpenDataConnector, InboundIntakeConnector, SamGovDemandConnector };
