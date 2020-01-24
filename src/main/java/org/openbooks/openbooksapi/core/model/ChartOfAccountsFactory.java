package org.openbooks.openbooksapi.core.model;

import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;
import org.openbooks.openbooksapi.core.SystemOptions;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

/**
 * Creates and returns {@link ChartOfAccounts} instances
 * based on a global {@link SystemOptions}.
 *
 */
@Component
public class ChartOfAccountsFactory {
	private static final Logger logger = LogManager.getLogger();

	@Autowired
	private SystemOptions options;
	
	public ChartOfAccountsFactory() {}
	
	public ChartOfAccounts build() {
		switch(options.getBookkeepingMethod()) {
		case DOUBLE_ENTRY:
			return new DoubleEntryChartOfAccounts();
		default:
			logger.error("Invalid PersistenceProvider");
			return null;
		}
	}
}
