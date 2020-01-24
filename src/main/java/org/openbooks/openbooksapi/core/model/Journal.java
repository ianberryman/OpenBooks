package org.openbooks.openbooksapi.core.model;

import org.springframework.data.repository.CrudRepository;

public interface Journal {
	
	public CrudRepository<Transaction, String> getTransactionRepository();
	
	public void commitTransaction(Transaction transaction);
}
