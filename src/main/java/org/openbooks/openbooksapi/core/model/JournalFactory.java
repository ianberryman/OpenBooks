package org.openbooks.openbooksapi.core.model;

import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;
import org.openbooks.openbooksapi.core.SystemOptions;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

@Component
public class JournalFactory {
	private static final Logger logger = LogManager.getLogger();
	
	@Autowired
	private SystemOptions options;
	
	public JournalFactory() {}
	
	public Journal build() {
		switch(options.getBookkeepingMethod()) {
		case DOUBLE_ENTRY:
			return new DoubleEntryJournal();
		default:
			logger.error("Invalid BookkeepingMethod");
			return null;
		}
		
	}
}
