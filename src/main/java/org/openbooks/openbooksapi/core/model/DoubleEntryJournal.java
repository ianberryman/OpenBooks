package org.openbooks.openbooksapi.core.model;

import org.springframework.data.repository.CrudRepository;

public class DoubleEntryJournal implements Journal {

	@Override
	public CrudRepository<Transaction, String> getTransactionRepository() {
		// TODO Auto-generated method stub
		return null;
	}

	@Override
	public void commitTransaction(Transaction transaction) {
		// TODO Auto-generated method stub
		
	}

}
