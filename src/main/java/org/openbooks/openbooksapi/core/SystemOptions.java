package org.openbooks.openbooksapi.core;

import javax.annotation.PostConstruct;

import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;
import org.openbooks.openbooksapi.core.model.ChartOfAccountsService;
import org.openbooks.openbooksapi.core.model.JournalService;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Component;

/**
 * Contains options used to bootstrap the factories
 * that create {@link JournalService}s and {@link ChartOfAccountsService}
 *
 */
@Component
public final class SystemOptions {
	private static final Logger logger = LogManager.getLogger();
	
	@Autowired
	private Environment env;
	
	public enum PersistenceProvider {
		INMEMORY; 
	}  
	
	public enum BookkeepingMethod {
		DOUBLE_ENTRY;
	}
	
	/**
	 * Identifies the data persistence provider
	 */
	private PersistenceProvider persistenceProvider;
	
	/**
	 * Bookkeeping method determines accounting model
	 */
	private BookkeepingMethod bookkeepingMethod;
	
	public SystemOptions() {}
	
	@PostConstruct
	public void init() {
		this.persistenceProvider = PersistenceProvider.valueOf(env.getProperty("openbooks.persistenceProvider"));
		this.bookkeepingMethod = BookkeepingMethod.valueOf(env.getProperty("openbooks.bookkeepingMethod"));
		
		logger.info(toString());
	}
	
	public PersistenceProvider getPersistenceProvider() {
		return persistenceProvider;
	}

	public BookkeepingMethod getBookkeepingMethod() {
		return bookkeepingMethod;
	}
	
	@Override
	public String toString() {
		String result = "";
		
		result += "\n" + "          System Options          " + "\n";
		result += new String(new char[34]).replace("\0", "=") + "\n";
		result += "PersistenceProvider: " + this.persistenceProvider + "\n";
		result += "BookkeepingMethod: " + this.bookkeepingMethod + "\n";
		
		return result;
	}
}
