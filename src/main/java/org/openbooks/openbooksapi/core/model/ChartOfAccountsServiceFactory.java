package org.openbooks.openbooksapi.core.model;

import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;
import org.openbooks.openbooksapi.core.SystemOptions;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

/**
 * Creates and returns {@link ChartOfAccountsService} instances
 * based on a global {@link SystemOptions}.
 *
 */
@Component
public class ChartOfAccountsServiceFactory {
	private static final Logger logger = LogManager.getLogger();

	@Autowired
	private SystemOptions options;
	
	public ChartOfAccountsServiceFactory() {}
	
	public ChartOfAccountsService build() {
		switch(options.getBookkeepingMethod()) {
		case DOUBLE_ENTRY:
			return new DoubleEntryChartOfAccountsService();
		default:
			logger.error("Invalid PersistenceProvider");
			return null;
		}
	}
}
